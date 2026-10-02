import { ComputeBudgetProgram, PublicKey, type Connection, type TransactionInstruction } from '@solana/web3.js';
import type { SymmetryCore, Vault, GlobalConfig } from '@symmetry-hq/sdk';
import { claimFeeTokensFromVaultIxs, withdrawFeesIx } from '@symmetry-hq/sdk/dist/instructions/management/claimFees.js';
import { getRebalanceIntentPda, getWithdrawVaultFeesPda } from '@symmetry-hq/sdk/dist/instructions/pda.js';
import { getMultipleAccountsInfoBatched, prepareVersionedTxs, prepareTxPayloadBatchSequence } from '@symmetry-hq/sdk/dist/txUtils.js';
import type { Config } from './config.js';
import { CliError } from './lib/utils.js';

export function claimableFeeTypes(vault: Vault, global: GlobalConfig, claimer: PublicKey) {
  const { creator, host, managers } = vault.settings;
  const allowed = [claimer.equals(global.symmetryFeeCollector), claimer.equals(creator), claimer.equals(host), claimer.equals(creator) || managers.managers.some(key => key.equals(claimer))];
  const amounts = [vault.accumulatedFees.symmetryFees, vault.accumulatedFees.creatorFees, vault.accumulatedFees.hostFees, vault.accumulatedFees.managersFees];
  return amounts.flatMap((amount, type) => allowed[type] && !amount.isZero() ? [type] : []);
}

// Build withdrawals only for accrued fees authorized for this signer.
export async function withdrawFeeTransactions(connection: Connection, config: Config, sdk: SymmetryCore, vault: Vault, claimer: PublicKey) {
  const global = await sdk.fetchGlobalConfig(), types = claimableFeeTypes(vault, global, claimer);
  if (!types.length) throw new CliError('NO_FEES', 'No accrued fees are withdrawable by this signer. Use fees list/claim for already withdrawn fees.');
  const pending = await connection.getMultipleAccountsInfo(types.map(type => getWithdrawVaultFeesPda(vault.ownAddress, type)));
  if (pending.some(Boolean)) throw new CliError('PENDING_FEES', 'A fee withdrawal account already exists. Claim it with fees claim before withdrawing again.');
  const mints = vault.composition.slice(0, vault.numTokens).map(asset => asset.mint);
  const infos = await getMultipleAccountsInfoBatched(connection, mints);
  const programs = mints.map(mint => {
    const info = infos.get(mint.toBase58());
    if (!info) throw new CliError('MINT_NOT_FOUND', `Fee mint ${mint} was not found.`);
    return info.owner;
  });
  const tx = (instruction: TransactionInstruction) => ({ payer: claimer, instructions: [instruction, ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFee })], lookupTables: [] });
  const data = { batches: [
    types.map(feeType => tx(withdrawFeesIx({ claimer, vaultTokenMint: vault.mint, feeType, vaultRebalanceIntent: vault.settings.activeRebalance.isZero() ? undefined : getRebalanceIntentPda(vault.ownAddress, vault.ownAddress) }))),
    types.flatMap(type => claimFeeTokensFromVaultIxs(claimer, vault.ownAddress, getWithdrawVaultFeesPda(vault.ownAddress, type), claimer, type === 3 ? vault.settings.managers.managers : [claimer], mints, programs).map(tx)),
  ] };
  return prepareTxPayloadBatchSequence(data, await prepareVersionedTxs(connection, data));
}
