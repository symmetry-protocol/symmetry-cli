import { ComputeBudgetProgram, PublicKey, type Connection, type TransactionInstruction } from '@solana/web3.js';
import type { RebalanceIntent, Vault } from '@symmetry-hq/sdk';
import { PYTHNET_CUSTODY_PRICE_USDC_ACCOUNT, PYTHNET_CUSTODY_PRICE_WSOL_ACCOUNT, UPDATE_TOKEN_PRICES_MAX_ACCOUNTS } from '@symmetry-hq/sdk/dist/constants.js';
import { OracleType } from '@symmetry-hq/sdk/dist/layouts/oracle.js';
import { getRebalanceIntentPda } from '@symmetry-hq/sdk/dist/instructions/pda.js';
import { updateTokenPricesIx } from '@symmetry-hq/sdk/dist/instructions/automation/priceUpdate.js';
import { buildPythPriceFeedUpdateIxs, fetchFeedIdsFromAccounts, resolvePythShard, type HermesClientLike } from '@symmetry-hq/sdk/dist/states/oracles/pythOracle.js';
import * as raydium from '@symmetry-hq/sdk/dist/states/oracles/raydiumClmmOracle.js';
import * as byreal from '@symmetry-hq/sdk/dist/states/oracles/byrealClmmOracle.js';
import { getMultipleAccountsInfoBatched, prepareVersionedTxs, prepareTxPayloadBatchSequence, type TxBatchData } from '@symmetry-hq/sdk/dist/txUtils.js';
import { z } from 'zod';
import { CliError } from './lib/utils.js';
import type { Config } from './config.js';

// Supply authentication, bounded responses and timeouts to the SDK's Pyth builder.
export function hermesClient(config: Config, fetcher = fetch): HermesClientLike {
  return { async getLatestPriceUpdates(feedIds, options) {
    const url = new URL(`${(config.hermesUrl ?? 'https://hermes.pyth.network').replace(/\/$/, '')}/v2/updates/price/latest`);
    for (const id of new Set(feedIds)) url.searchParams.append('ids[]', id);
    url.searchParams.set('encoding', options.encoding);
    const key = process.env.PYTH_API_KEY;
    const response = await fetcher(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs) });
    if (response.status === 401 || response.status === 403) throw new CliError('ORACLE_AUTH_REQUIRED', 'Hermes requires a valid PYTH_API_KEY environment variable or an authorized --hermes-url provider. No transaction was submitted.');
    if (!response.ok) throw new CliError('ORACLE_UNAVAILABLE', `Hermes returned HTTP ${response.status}.`, undefined, response.status === 429 || response.status >= 500);
    const maxBytes = 4 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > maxBytes) throw new CliError('ORACLE_RESPONSE_INVALID', 'Hermes response exceeds 4 MiB.');
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new CliError('ORACLE_RESPONSE_INVALID', 'Hermes response exceeds 4 MiB.');
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
    }
    const payload = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    try { body = JSON.parse(payload); } catch { throw new CliError('ORACLE_RESPONSE_INVALID', 'Hermes returned invalid JSON.'); }
    const parsed = z.object({ binary: z.object({ data: z.array(z.string().min(1).max(2 * 1024 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)).min(1).max(100) }) }).safeParse(body);
    if (!parsed.success) throw new CliError('ORACLE_RESPONSE_INVALID', 'Hermes returned an invalid price-update response.');
    return parsed.data;
  } };
}

export async function priceTransactions(connection: Connection, config: Config, vault: Vault, intent: PublicKey, keeper: PublicKey, refreshPyth: boolean, intentTokens: RebalanceIntent['tokens']) {
  const feeds = new Map([PYTHNET_CUSTODY_PRICE_WSOL_ACCOUNT, PYTHNET_CUSTODY_PRICE_USDC_ACCOUNT].map(key => [key.toBase58(), key]));
  const updates: TransactionInstruction[] = [];
  const requiredIndices = vault.composition.slice(0, vault.numTokens).flatMap((asset, index) => {
    const token = intentTokens.find(token => token.mint.equals(asset.mint));
    return token && (asset.active === 1 || !asset.amount.isZero() || !token.amount.isZero()) ? [index] : [];
  });
  const oracleAccounts = requiredIndices.map(index => vault.composition[index]!.oracleAggregator.oracles
    .slice(0, vault.composition[index]!.oracleAggregator.numOracles).map(oracle => ({ oracle, keys: Array.from({ length: oracle.oracleSettings.numRequiredAccounts }, (_, index) => {
      const key = vault.lutPubkeys?.[oracle.accountsToLoadLutIds[index]!]?.state.addresses[oracle.accountsToLoadLutIndices[index]!];
      if (!key) throw new CliError('LOOKUP_TABLE_MISSING', 'Oracle account is missing from the vault lookup tables.');
      if (oracle.oracleSettings.oracleType === OracleType.Pyth) feeds.set(key.toBase58(), key);
      return key;
    }) })));
  const guarded = oracleAccounts.flat().filter(({ oracle }) => [OracleType.RaydiumClmm, OracleType.ByrealClmm].includes(oracle.oracleSettings.oracleType) && oracle.oracleSettings.minLiquidity.gtn(0));
  const poolInfos = await getMultipleAccountsInfoBatched(connection, guarded.map(({ keys }) => keys[0]!));
  for (const { oracle, keys } of guarded) {
    const poolKey = keys[0]!, info = poolInfos.get(poolKey.toBase58());
    if (!info) throw new CliError('ORACLE_ACCOUNT_MISSING', `CLMM pool ${poolKey} was not found.`);
    const clmm = oracle.oracleSettings.oracleType === OracleType.RaydiumClmm ? raydium : byreal;
    const pool = oracle.oracleSettings.oracleType === OracleType.RaydiumClmm ? raydium.RaydiumClmmPoolState.decode(info.data) : byreal.ByrealClmmPoolState.decode(info.data);
    if (pool.tickSpacing <= 0) throw new CliError('INVALID_ORACLE', 'CLMM tick spacing must be positive.');
    const current = clmm.getTickArrayStartIndexByTick(pool.tickCurrent, pool.tickSpacing);
    keys.push(...[clmm.getNextTickArrayStartIndex(current, pool.tickSpacing, true), current, clmm.getNextTickArrayStartIndex(current, pool.tickSpacing, false)]
      .map(start => clmm.getPdaTickArrayAddress(poolKey, start, info.owner)));
  }
  const tokenAccounts = oracleAccounts.map(oracles => oracles.flatMap(({ keys }) => keys));
  for (let start = 0; start < requiredIndices.length;) {
    const keys: PublicKey[] = [], indices: number[] = [];
    let oracleLoads = 0;
    while (start < requiredIndices.length && indices.length < 20) {
      const asset = vault.composition[requiredIndices[start]!]!;
      const oracles = asset.oracleAggregator.oracles.slice(0, asset.oracleAggregator.numOracles);
      const accounts = tokenAccounts[start]!, count = accounts.length;
      if (count > UPDATE_TOKEN_PRICES_MAX_ACCOUNTS) throw new CliError('ORACLE_ACCOUNT_LIMIT', 'A token oracle exceeds the price-update account limit.');
      // Bound feed loads per transaction and isolate complex oracle tokens.
      const loads = oracles.some(oracle => oracle.oracleSettings.oracleType !== OracleType.Pyth) ? 10 : oracles.length;
      // The last price also calculates all targets; reserve a separate transaction for that work.
      if (keys.length + count > UPDATE_TOKEN_PRICES_MAX_ACCOUNTS || (indices.length > 0 && (oracleLoads + loads > 10 || start === requiredIndices.length - 1))) break;
      oracleLoads += loads;
      indices.push(requiredIndices[start++]!);
      keys.push(...accounts);
    }
    updates.push(updateTokenPricesIx({ keeper, vault: vault.ownAddress, rebalanceIntent: intent, lookupTable0: vault.lookupTables.active[0]!, lookupTable1: vault.lookupTables.active[1]!, tokenIndices: [...indices, ...Array(20 - indices.length).fill(255)], additionalOracleAccounts: keys, vaultRebalanceIntent: vault.settings.activeRebalance.isZero() ? undefined : getRebalanceIntentPda(vault.ownAddress, vault.ownAddress), vaultMint: vault.settings.fees.hostPerformanceFeeBps + vault.settings.fees.creatorPerformanceFeeBps + vault.settings.fees.managersPerformanceFeeBps > 0 ? vault.mint : undefined }));
  }
  let pyth: Awaited<ReturnType<typeof buildPythPriceFeedUpdateIxs>> | undefined;
  if (refreshPyth) {
    const accounts = [...feeds.values()], { feedIds } = await fetchFeedIdsFromAccounts(connection, accounts);
    const priceFeeds = feedIds.map((feedId, index) => {
      const shardId = resolvePythShard(accounts[index]!, feedId);
      if (shardId === null) throw new CliError('INVALID_ORACLE', `Pyth account ${accounts[index]} is not a supported canonical feed account.`);
      return { feedId, shardId };
    });
    pyth = await buildPythPriceFeedUpdateIxs(keeper, priceFeeds, hermesClient(config));
  }
  const tx = (instructions: TransactionInstruction[], lookupTables: PublicKey[] = [], units = 1_000_000) => ({ payer: keeper, instructions: [...instructions, ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFee })], lookupTables });
  const data: TxBatchData = { batches: [
    ...(pyth ? [pyth.vaaCreateInitEncodeIxs.map(item => tx(item.ixs)), pyth.vaaWriteVerifyIxs.map(ixs => tx(ixs)), pyth.updateFeedIxs.map(ix => tx([ix]))] : []),
    updates.map(ix => tx([ix], vault.lookupTables.active, 1_400_000)),
    ...(pyth?.closeVaaIxs.length ? [[tx(pyth.closeVaaIxs)]] : []),
  ] };
  const prepared = await prepareVersionedTxs(connection, data);
  pyth?.vaaCreateInitEncodeIxs.forEach((item, index) => prepared.batches[0]![index]!.sign([item.signer]));
  return prepareTxPayloadBatchSequence(data, prepared);
}
