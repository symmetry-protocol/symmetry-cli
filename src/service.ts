import { PublicKey, type Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackMint } from '@solana/spl-token';
import { SymmetryCore, type TxPayloadBatchSequence, type Vault, type VaultCreationTx } from '@symmetry-hq/sdk';
import { VAULTS_V3_PROGRAM_ID, MINTS } from '@symmetry-hq/sdk/dist/constants.js';
import { getRebalanceIntentPda } from '@symmetry-hq/sdk/dist/instructions/pda.js';
import { RebalanceAction, RebalanceType } from '@symmetry-hq/sdk/dist/layouts/intents/rebalanceIntent.js';
import { delay } from '@symmetry-hq/sdk/dist/txUtils.js';
import { commands, parse, type Action, type CommandName, type Input } from './commands.js';
import { assertNetwork, connect, ownerAddress, publicConfig, type Config } from './config.js';
import { CliError } from './lib/utils.js';
import sdkPackage from '@symmetry-hq/sdk/package.json' with { type: 'json' };
import { priceTransactions } from './prices.js';
import { withdrawFeeTransactions } from './fees.js';
import { validateBountyAmount } from './bounty.js';
import { exactSolBalance } from './rpc.js';

export class Service {
  readonly connection: Connection;
  readonly sdk: SymmetryCore;
  constructor(readonly config: Config, connection = connect(config), sdk?: SymmetryCore) {
    this.connection = connection;
    this.sdk = sdk ?? new SymmetryCore({ connection, network: config.network, priorityFee: config.priorityFee });
  }
  async checkNetwork() { await assertNetwork(this.connection, this.config.network); }
  async owner() { return ownerAddress(this.config); }

  async vault(address: string): Promise<Vault> {
    const vault = await this.sdk.fetchVault(address);
    if (!vault || vault.ownAddress.toBase58() !== address) throw new CliError('VAULT_NOT_FOUND', 'Vault state account was not found. Use vault from-mint for share-token mints.');
    return vault;
  }
  async assertSettleable(vault: Vault) {
    if (vault.numTokens > 50)
      throw new CliError('UNSUPPORTED_CONFIGURATION', 'This operation is unavailable for the current basket configuration. In-kind withdrawal and recovery remain available.');
  }
  view(vault: Vault) {
    return { ...vault.formatted, composition: vault.formatted?.composition.slice(0, vault.numTokens), exact: {
      supplyOutstanding: vault.supplyOutstanding.toString(), bountyBalance: vault.settings.bountyBalance.toString(),
      assets: vault.composition.slice(0, vault.numTokens).map(asset => ({ mint: asset.mint.toBase58(), amount: asset.amount.toString(), weightBps: asset.weight, active: asset.active === 1 })),
    } };
  }
  async read(name: CommandName, input: unknown): Promise<unknown> {
    if (name === 'wallet.address') return { address: await this.owner() };
    await this.checkNetwork();
    switch (name) {
      case 'status': {
        const [program, config, slot] = await Promise.all([this.connection.getAccountInfo(VAULTS_V3_PROGRAM_ID), this.sdk.fetchGlobalConfig(), this.connection.getSlot('confirmed')]);
        if (!program?.executable) throw new CliError('PROGRAM_UNAVAILABLE', 'Symmetry program is not executable on this RPC.');
        return { ...publicConfig(this.config), slot, programId: VAULTS_V3_PROGRAM_ID.toBase58(), allowCreation: config.allowCreation, allowInteractions: config.allowInteractions, sdkVersion: sdkPackage.version };
      }
      case 'wallet.balance': {
        const owner = new PublicKey(parse(name, input).owner ?? await this.owner());
        const [solLamports, ...tokens] = await Promise.all([exactSolBalance(this.config.rpcUrl ?? this.connection.rpcEndpoint, owner.toBase58(), this.config.timeoutMs), ...[TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map(programId => this.connection.getParsedTokenAccountsByOwner(owner, { programId }))]);
        return { owner: owner.toBase58(), solLamports, tokens: tokens.flatMap(response => response.value.map(account => ({ account: account.pubkey.toBase58(), program: account.account.owner.toBase58(), mint: account.account.data.parsed.info.mint, amount: account.account.data.parsed.info.tokenAmount.amount, decimals: account.account.data.parsed.info.tokenAmount.decimals }))) };
      }
      case 'vault.list': {
        const value = parse(name, input);
        const vaults = await this.sdk.fetchAllVaults(value.role && value.owner ? { type: value.role, pubkey: value.owner } : undefined);
        vaults.sort((a, b) => a.ownAddress.toBase58().localeCompare(b.ownAddress.toBase58()));
        return { total: vaults.length, offset: value.offset, limit: value.limit, vaults: vaults.slice(value.offset, value.offset + value.limit).map(vault => this.view(vault)) };
      }
      case 'vault.show': return this.view(await this.vault(parse(name, input).vault));
      case 'token.show': {
        const mint = new PublicKey(parse(name, input).mint), info = await this.connection.getAccountInfo(mint);
        if (!info || ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(program => program.equals(info.owner))) throw new CliError('MINT_NOT_FOUND', 'No supported SPL token mint at this address.');
        const token = unpackMint(mint, info, info.owner);
        return { mint: mint.toBase58(), tokenProgram: info.owner.toBase58(), decimals: token.decimals, supply: token.supply.toString(), mintAuthority: token.mintAuthority?.toBase58() ?? null, freezeAuthority: token.freezeAuthority?.toBase58() ?? null };
      }
      case 'vault.price': {
        const vault = await this.sdk.loadVaultPrice(await this.vault(parse(name, input).vault));
        return { vault: vault.ownAddress.toBase58(), mint: vault.mint.toBase58(), tvlUsd: vault.tvl?.toString() ?? null, usdPerRawShare: vault.price?.toString() ?? null, assets: vault.composition.slice(0, vault.numTokens).map(asset => ({ mint: asset.mint.toBase58(), amount: asset.amount.toString(), valueUsd: asset.value?.toString() ?? null, usdPerRawUnit: asset.price?.price.toString() ?? null })), note: 'Indicative on-chain oracle data, not a guaranteed execution quote. Per-unit prices are for one raw base unit.' };
      }
      case 'vault.from-mint': {
        const mint = parse(name, input).mint;
        const vault = (await this.sdk.fetchVaultsFromMints([mint])).get(mint);
        if (!vault) throw new CliError('VAULT_NOT_FOUND', 'No vault found for this share mint.');
        return this.view(vault);
      }
      case 'intent.list': return (await this.sdk.fetchVaultIntents(parse(name, input).vault)).map(value => value.formatted);
      case 'intent.show': return (await this.sdk.fetchIntent(parse(name, input).intent)).formatted;
      case 'rebalance.list': {
        const value = parse(name, input);
        const intents = value.vault ? await this.sdk.fetchVaultRebalanceIntents(value.vault) : await this.sdk.fetchOwnerRebalanceIntents(value.owner!);
        return intents.map(({ chain_data, ...data }) => ({ ...data, exactTokens: chain_data.tokens.map(token => ({ mint: token.mint.toBase58(), amount: token.amount.toString(), targetAmount: token.targetAmount.toString() })) }));
      }
      case 'rebalance.show': {
        const { chain_data, ...data } = await this.sdk.fetchRebalanceIntent(parse(name, input).intent);
        return { ...data, exactTokens: chain_data.tokens.map(token => ({ mint: token.mint.toBase58(), amount: token.amount.toString(), targetAmount: token.targetAmount.toString() })) };
      }
      case 'fees.list': return (await this.sdk.fetchVaultWithdrawVaultFees(parse(name, input).vault)).map(value => value.formatted);
      default: throw new CliError('INVALID_COMMAND', `${name} is not a read command.`);
    }
  }

  async expand(name: CommandName, input: unknown, owner: string): Promise<{ actions: Action[]; first?: TxPayloadBatchSequence; result?: unknown }> {
    if (!commands[name].write) throw new CliError('INVALID_COMMAND', 'Only write commands can create plans.');
    await this.checkNetwork();
    if (name === 'vault.create') {
      const value = parse(name, input);
      const custodyMints = Object.values(MINTS[this.config.network]!).map(key => key.toBase58());
      if (value.assets?.some(asset => !asset.token && !custodyMints.includes(asset.mint)))
        throw new CliError('ORACLE_CONFIGURATION_REQUIRED', 'Supply explicit token/oracle settings for every new asset before creating the vault.');
      if (new Set([...custodyMints, ...(value.assets ?? []).map(asset => asset.mint)]).size > 100)
        throw new CliError('ASSET_LIMIT', 'Composition exceeds 100 token slots, including protocol custody assets.');
      const first = await this.build({ command: name, input: value }, owner) as VaultCreationTx;
      const actions: Action[] = [{ command: name, input: value }];
      if (value.assets) {
        for (const asset of value.assets) if (asset.token) actions.push({ command: 'vault.token-set', input: { vault: first.vault, token: asset.token } });
        actions.push({ command: 'vault.weights', input: { vault: first.vault, assets: value.assets.map(({ mint, weightBps }) => ({ mint, weightBps })) } });
      }
      return { actions, first, result: { vault: first.vault, mint: first.mint } };
    }
    if (name === 'vault.compose') {
      const value = parse(name, input);
      const vault = await this.vault(value.vault);
      if (!vault.settings.addTokenDelay.isZero() || !vault.settings.updateWeightsDelay.isZero()) throw new CliError('TIMELOCKED_COMPOSITION', 'Use separate add-token and weights intents for a vault with composition time locks.');
      const active = vault.composition.slice(0, vault.numTokens).filter(asset => asset.active === 1).map(asset => asset.mint.toBase58());
      const missing = value.assets.filter(asset => !active.includes(asset.mint));
      if (vault.numTokens + missing.filter(asset => !vault.composition.some(existing => existing.mint.toBase58() === asset.mint)).length > 100) throw new CliError('ASSET_LIMIT', 'Composition exceeds 100 token slots.');
      if (missing.some(asset => !asset.token)) throw new CliError('ORACLE_CONFIGURATION_REQUIRED', 'Supply explicit token/oracle settings for each new or inactive asset.');
      return { actions: [
        ...value.assets.filter(asset => asset.token).map(asset => ({ command: 'vault.token-set' as const, input: { vault: value.vault, token: asset.token } })),
        { command: 'vault.weights', input: { vault: value.vault, assets: value.assets.map(({ mint, weightBps }) => ({ mint, weightBps })) } },
      ] };
    }
    const actions: Action[] = [{ command: name, input: parse(name, input) }];
    if (name === 'vault.deposit') actions.push({ command: 'vault.lock', input: { vault: parse(name, input).vault } });
    return { actions };
  }

  async build(action: Action, owner: string): Promise<TxPayloadBatchSequence> {
    const { command: name, input } = action;
    const context = (value: { vault: string; activationTimestamp?: number; expirationTimestamp?: number }) => ({ vault: value.vault, manager: owner, activation_timestamp: value.activationTimestamp, expiration_timestamp: value.expirationTimestamp });
    switch (name) {
      case 'vault.create': {
        const value = parse(name, input);
        const payload = await this.sdk.createVaultTx({ creator: owner, name: value.name, symbol: value.symbol, metadata_uri: value.metadataUri, start_price: value.startPrice });
        // Lookup-table creation needs a slot in SlotHashes, which excludes the current bank's slot.
        const slot = await this.connection.getSlot('confirmed'), deadline = Date.now() + this.config.timeoutMs;
        while (await this.connection.getSlot('confirmed') <= slot) {
          if (Date.now() >= deadline) throw new CliError('RPC_NOT_ADVANCING', 'Wait for the RPC to advance before preparing creation.', undefined, true);
          await delay(200);
        }
        return payload;
      }
      case 'vault.add-token':
      case 'vault.token-set': { const value = parse(name, input); return this.sdk.addOrEditTokenTx(context(value), value.token); }
      case 'vault.weights': {
        const value = parse(name, input);
        const vault = await this.vault(value.vault);
        const active = vault.composition.slice(0, vault.numTokens).filter(asset => asset.active === 1).map(asset => asset.mint.toBase58());
        if (value.assets.some(asset => !active.includes(asset.mint))) throw new CliError('ASSET_NOT_ACTIVE', 'All target assets must be active before building weights. Complete their add-token intents first.');
        // The SDK hashes and indexes the freshly fetched on-chain composition.
        return this.sdk.updateWeightsTx(context(value), { token_weights: value.assets.map(asset => ({ mint: asset.mint, weight_bps: asset.weightBps })) });
      }
      case 'vault.edit': {
        const value = parse(name, input), ctx = context(value), change = value.change;
        switch (change.kind) {
          case 'creator': return this.sdk.editCreatorTx(ctx, change.settings);
          case 'managers': return this.sdk.editManagersTx(ctx, change.settings);
          case 'fees': return this.sdk.editFeesTx(ctx, change.settings);
          case 'metadata': return this.sdk.editMetadataTx(ctx, change.settings);
          case 'deposits': return this.sdk.editDepositsTx(ctx, change.settings);
          case 'automation': return this.sdk.editAutomationTx(ctx, change.settings);
          case 'schedule': return this.sdk.editScheduleTx(ctx, change.settings);
        }
      }
      case 'vault.deposit': {
        const value = parse(name, input), vault = await this.vault(value.vault);
        await this.assertSettleable(vault);
        const pending = getRebalanceIntentPda(vault.ownAddress, new PublicKey(owner));
        if (await this.connection.getAccountInfo(pending)) throw new CliError('PENDING_INTENT', `Existing deposit/withdrawal intent: ${pending}. Resume its plan or use deposit-more/lock/cancel/redeem.`);
        const active = vault.composition.slice(0, vault.numTokens).filter(asset => asset.active === 1).map(asset => asset.mint.toBase58());
        if (value.contributions.some(item => !active.includes(item.mint))) throw new CliError('ASSET_NOT_ACTIVE', 'Contributions must use active vault assets.');
        validateBountyAmount(await this.sdk.fetchGlobalConfig(), vault, RebalanceType.Deposit, owner, value.contributions.find(item => item.mint === MINTS.mainnet!.WSOL!.toBase58())?.amount);
        return this.sdk.buyVaultTx({ buyer: owner, vault_mint: vault.mint.toBase58(), contributions: value.contributions.map(item => ({ mint: item.mint, amount: Number(item.amount) })), rebalance_slippage_bps: value.slippageBps, per_trade_rebalance_slippage_bps: value.perTradeSlippageBps });
      }
      case 'vault.deposit-more': {
        const value = parse(name, input), intent = (await this.sdk.fetchRebalanceIntent(value.intent)).chain_data;
        if (!intent.owner.equals(new PublicKey(owner)) || !getRebalanceIntentPda(intent.vault, intent.owner).equals(new PublicKey(value.intent))) throw new CliError('INTENT_MISMATCH', 'Deposit intent does not belong to the signer.');
        if (intent.rebalanceType !== RebalanceType.Deposit || intent.currentAction !== RebalanceAction.DepositTokens) throw new CliError('INTENT_NOT_OPEN', 'Deposit intent is not unlocked.');
        await this.assertSettleable(await this.vault(intent.vault.toBase58()));
        return this.sdk.depositTokensTx({ buyer: owner, rebalance_intent_chain_data: intent, contributions: value.contributions.map(item => ({ mint: item.mint, amount: Number(item.amount) })) });
      }
      case 'vault.lock': { const vault = await this.vault(parse(name, input).vault); await this.assertSettleable(vault); return this.sdk.lockDepositsTx({ buyer: owner, vault_mint: vault.mint.toBase58() }); }
      case 'vault.withdraw': {
        const value = parse(name, input), vault = await this.vault(value.vault);
        const keepTokens = value.keepTokens ?? vault.composition.slice(0, vault.numTokens).map(asset => asset.mint.toBase58());
        if (vault.composition.slice(0, vault.numTokens).some(asset => !keepTokens.includes(asset.mint.toBase58()))) await this.assertSettleable(vault);
        // The pinned sell builder uses the deposit bounty calculation as well.
        validateBountyAmount(await this.sdk.fetchGlobalConfig(), vault, RebalanceType.Deposit, owner);
        return this.sdk.sellVaultTx({ seller: owner, vault_mint: vault.mint.toBase58(), withdraw_amount: Number(value.amount), keep_tokens: keepTokens, rebalance_slippage_bps: value.slippageBps, per_trade_rebalance_slippage_bps: value.perTradeSlippageBps });
      }
      case 'vault.rebalance': { const value = parse(name, input), vault = await this.vault(value.vault); await this.assertSettleable(vault); validateBountyAmount(await this.sdk.fetchGlobalConfig(), vault, RebalanceType.Vault, owner); return this.sdk.rebalanceVaultTx({ keeper: owner, vault_mint: vault.mint.toBase58(), rebalance_slippage_bps: value.slippageBps, per_trade_rebalance_slippage_bps: value.perTradeSlippageBps }); }
      case 'vault.bounty': { const value = parse(name, input); return this.sdk.addBountyTx({ keeper: owner, vault: value.vault, amount: Number(value.amount) }); }
      case 'intent.execute': return this.sdk.executeVaultIntentTx({ keeper: owner, intent: parse(name, input).intent });
      case 'intent.cancel': return this.sdk.cancelVaultIntentTx({ keeper: owner, intent: parse(name, input).intent });
      case 'rebalance.cancel': return this.sdk.cancelRebalanceIntentTx({ keeper: owner, rebalance_intent: parse(name, input).intent });
      case 'rebalance.mint': return this.sdk.mintTx({ keeper: owner, rebalance_intent: parse(name, input).intent });
      case 'rebalance.redeem': return this.sdk.redeemTokensTx({ keeper: owner, rebalance_intent: parse(name, input).intent });
      case 'rebalance.claim-bounty': return this.sdk.claimBountyTx({ keeper: owner, rebalance_intent: parse(name, input).intent });
      case 'rebalance.prices': { const value = parse(name, input); const intent = await this.sdk.fetchRebalanceIntent(value.intent); return priceTransactions(this.connection, this.config, await this.vault(intent.formatted_data.vault), new PublicKey(value.intent), new PublicKey(owner), value.refreshPyth, intent.chain_data.tokens); }
      case 'fees.withdraw': return withdrawFeeTransactions(this.connection, this.config, this.sdk, await this.vault(parse(name, input).vault), new PublicKey(owner));
      case 'fees.claim': return this.sdk.claimTokenFeesFromVaultTx({ claimer: owner, withdrawVaultFees: parse(name, input).account });
      default: throw new CliError('INVALID_COMMAND', `Cannot build ${name}.`);
    }
  }

  async verify(actions: Action[]) {
    const last = actions.at(-1);
    if (last?.command !== 'vault.weights') return { transactionsConfirmed: true, settlement: actions.some(action => ['vault.deposit', 'vault.withdraw', 'vault.rebalance'].includes(action.command)) ? 'Check rebalance intents; transaction confirmation does not imply settlement.' : undefined };
    const value: Input<'vault.weights'> = parse('vault.weights', last.input);
    if (value.activationTimestamp) return { transactionsConfirmed: true, composition: 'scheduled_intent' };
    const vault = await this.vault(value.vault);
    if (!vault.settings.updateWeightsDelay.isZero()) return { transactionsConfirmed: true, composition: 'timelocked_intent' };
    const actual = vault.composition.slice(0, vault.numTokens).filter(asset => asset.active === 1);
    const matches = actual.every(asset => asset.weight === (value.assets.find(target => target.mint === asset.mint.toBase58())?.weightBps ?? 0)) && value.assets.every(target => actual.some(asset => asset.mint.toBase58() === target.mint));
    if (!matches) throw new CliError('VERIFICATION_FAILED', 'Transactions confirmed but on-chain weights do not match. Inspect the vault before changing it again.');
    return { transactionsConfirmed: true, composition: 'verified', vault: value.vault };
  }
}
