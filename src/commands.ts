import { z } from 'zod';
import { address, bps, empty, rawAmount, uint } from './lib/utils.js';

const text = (bytes: number) => z.string().max(bytes).refine(value => Buffer.byteLength(value) >= 3 && Buffer.byteLength(value) <= bytes, `Use 3-${bytes} UTF-8 bytes`);
const symbol = text(10).regex(/^[A-Za-z0-9]+$/, 'Use only ASCII letters and digits');
const uri = z.string().max(200).refine(value => Buffer.byteLength(value) <= 200 && (value === '' || /^(https:\/\/|ipfs:\/\/)/.test(value)), 'Use HTTPS or IPFS, at most 200 UTF-8 bytes');
const weights = z.array(z.strictObject({ mint: address, weightBps: bps })).min(1).max(100)
  .refine(items => new Set(items.map(item => item.mint)).size === items.length, 'Duplicate mints')
  .refine(items => items.reduce((sum, item) => sum + item.weightBps, 0) === 10_000, 'Weights must total 10000 bps');
const context = { activationTimestamp: uint.optional(), expirationTimestamp: uint.optional() };
const trade = { slippageBps: bps.max(1000).default(100), perTradeSlippageBps: bps.max(1000).default(100) };
const automationBps = bps.max(9999);
const vault = z.strictObject({ vault: address });
const intent = z.strictObject({ intent: address });
const filter = z.strictObject({ role: z.enum(['creator', 'host', 'manager']).optional(), owner: address.optional(), limit: uint.min(1).max(1000).default(100), offset: uint.default(0) })
  .refine(input => Boolean(input.role) === Boolean(input.owner), 'role and owner must be supplied together');
const oracle = z.strictObject({
  oracle_type: z.enum(['pyth', 'raydium_cpmm', 'raydium_clmm']), account: address,
  account_lut_id: uint.max(255).default(0), account_lut_index: uint.max(255).default(0),
  weight_bps: bps, is_required: z.boolean(), conf_thresh_bps: bps,
  volatility_thresh_bps: uint.max(65535), max_slippage_bps: bps, min_liquidity: uint,
  staleness_thresh: uint, staleness_conf_rate_bps: bps, token_decimals: uint.max(255),
  twap_seconds_ago: uint, twap_secondary_seconds_ago: uint, quote_token: z.enum(['usd', 'usdc', 'wsol']),
});
const token = z.strictObject({
  token_mint: address, active: z.boolean(), min_oracles_thresh: uint.min(1).max(4),
  min_conf_bps: bps, conf_thresh_bps: bps, conf_multiplier: uint.min(1).max(65535),
  oracles: z.array(oracle).min(1).max(4),
}).refine(value => value.min_oracles_thresh <= value.oracles.length, 'Not enough oracles');
const assets = z.array(z.strictObject({
  mint: address, weightBps: bps,
  token: token.optional().describe('Caller-selected oracle configuration. Required for new or inactive assets; omit to retain settings for an asset already active in the target vault.'),
}).refine(value => !value.token || (value.token.token_mint === value.mint && value.token.active), 'Token configuration must match the asset mint and be active')).min(1).max(100)
  .refine(items => new Set(items.map(item => item.mint)).size === items.length, 'Duplicate mints')
  .refine(items => items.reduce((sum, item) => sum + item.weightBps, 0) === 10_000, 'Weights must total 10000 bps');
const fees = z.strictObject({
  creator_deposit_fee_bps: bps, creator_withdraw_fee_bps: bps,
  creator_management_fee_bps: z.literal(0), creator_performance_fee_bps: z.literal(0),
  managers_deposit_fee_bps: bps, managers_withdraw_fee_bps: bps,
  managers_management_fee_bps: z.literal(0), managers_performance_fee_bps: z.literal(0),
  vault_deposit_fee_bps: bps, vault_withdraw_fee_bps: bps, modification_delay: uint,
});
const authority = z.strictObject(Object.fromEntries(['managers', 'fees', 'schedule', 'automation', 'lp', 'metadata', 'deposits', 'force_rebalance', 'custom_rebalance', 'add_token', 'update_weights', 'make_direct_swap'].map(key => [key, z.boolean()])) as Record<'managers' | 'fees' | 'schedule' | 'automation' | 'lp' | 'metadata' | 'deposits' | 'force_rebalance' | 'custom_rebalance' | 'add_token' | 'update_weights' | 'make_direct_swap', z.ZodBoolean>);
const settings = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('metadata'), settings: z.strictObject({ name: text(32), symbol, uri, modification_delay: uint }) }),
  z.strictObject({ kind: z.literal('fees'), settings: fees }),
  z.strictObject({ kind: z.literal('deposits'), settings: z.strictObject({ enabled: z.boolean() }) }),
  z.strictObject({ kind: z.literal('creator'), settings: z.strictObject({ creator: address }) }),
  z.strictObject({ kind: z.literal('managers'), settings: z.strictObject({ managers: z.array(z.strictObject({ pubkey: address, fee_split_weight_bps: bps, authorities: authority })).min(1).max(10), modification_delay: uint }).refine(value => new Set(value.managers.map(item => item.pubkey)).size === value.managers.length && value.managers.reduce((sum, item) => sum + item.fee_split_weight_bps, 0) === 10000, 'Managers must be unique and weights total 10000') }),
  z.strictObject({ kind: z.literal('automation'), settings: z.strictObject({ enabled: z.boolean(), rebalance_slippage_threshold_bps: automationBps, per_trade_rebalance_slippage_threshold_bps: automationBps, rebalance_activation_threshold_abs_bps: automationBps, rebalance_activation_threshold_rel_bps: automationBps, rebalance_activation_cooldown: uint, modification_delay: uint }) }),
  z.strictObject({ kind: z.literal('schedule'), settings: z.strictObject({ cycle_start_time: uint, cycle_duration: uint.min(600), deposits_start: uint, deposits_end: uint, automation_start: uint, automation_end: uint, management_start: uint, management_end: uint, modification_delay: uint }).refine(value => ['deposits', 'automation', 'management'].every(key => { const range = value as unknown as Record<string, number>; return range[`${key}_end`]! - range[`${key}_start`]! >= 600 && range[`${key}_end`]! <= value.cycle_duration; }), 'Each window must last at least 600 seconds and fit inside the cycle') }),
]);
const read = <S extends z.ZodType>(description: string, schema: S) => ({ description, schema, write: false as const });
const write = <S extends z.ZodType>(description: string, schema: S) => ({ description, schema, write: true as const });

export const commands = {
  'status': read('Check RPC cluster and deployed Symmetry program/configuration.', empty),
  'wallet.address': read('Show the configured public key. Never exports secret keys.', empty),
  'wallet.balance': read('SOL and SPL balances in exact raw units.', z.strictObject({ owner: address.optional() })),
  'token.show': read('Read mint decimals, exact supply, token program and mint authorities.', z.strictObject({ mint: address })),
  'vault.list': read('List vaults with optional role filtering and pagination.', filter),
  'vault.show': read('Fetch a vault by state address, including exact on-chain amounts.', vault),
  'vault.price': read('Read indicative on-chain oracle valuation, with explicit price units. This is not an execution quote.', vault),
  'vault.from-mint': read('Find a vault by its share-token mint.', z.strictObject({ mint: address })),
  'vault.create': write('Create a private vault with caller-selected assets. Supply explicit token/oracle settings for each new asset; no asset discovery or recommendations.', z.strictObject({ name: text(32), symbol, metadataUri: uri.default(''), startPrice: z.string().regex(/^[0-9]+(?:\.[0-9]+)?$/).refine(value => Number(value) > 0.000001 && Number(value) <= 1_000_000, 'Start price must be > 0.000001 and <= 1000000').default('1'), assets: assets.optional() })),
  'vault.compose': write('Compose caller-selected assets and weights. New or inactive assets require explicit token/oracle settings; settings already active in the target vault are retained when omitted.', z.strictObject({ vault: address, assets })),
  'vault.weights': write('Set weights for existing active assets; omitted assets receive zero weight.', z.strictObject({ vault: address, assets: weights, ...context })),
  'vault.add-token': write('Add or reactivate a caller-selected asset with explicit oracle settings. Caller must verify the mint/oracle pairing.', z.strictObject({ vault: address, token: token.refine(value => value.active, 'Added tokens must be active'), ...context })),
  'vault.token-set': write('Configure caller-selected Pyth, Raydium CPMM or Raydium CLMM oracles. Caller must verify the mint/oracle pairing and choose all risk thresholds.', z.strictObject({ vault: address, token, ...context })),
  'vault.edit': write('Change vault settings through protocol permission checks and time locks.', z.strictObject({ vault: address, change: settings, ...context })),
  'vault.deposit': write('Deposit raw token units and lock deposits. Settlement proceeds through keepers.', z.strictObject({ vault: address, contributions: z.array(z.strictObject({ mint: address, amount: rawAmount })).min(1).max(100).refine(items => new Set(items.map(item => item.mint)).size === items.length, 'Duplicate contribution mints'), ...trade })),
  'vault.deposit-more': write('Add contributions to an existing unlocked deposit intent.', z.strictObject({ intent: address, contributions: z.array(z.strictObject({ mint: address, amount: rawAmount })).min(1).max(100).refine(items => new Set(items.map(item => item.mint)).size === items.length, 'Duplicate contribution mints') })),
  'vault.lock': write('Lock an existing deposit and begin settlement.', vault),
  'vault.withdraw': write('Burn raw vault share units. Omit keepTokens to receive all underlying assets in kind.', z.strictObject({ vault: address, amount: rawAmount, keepTokens: z.array(address).max(100).optional(), ...trade })),
  'vault.rebalance': write('Request a vault rebalance through the protocol auction.', z.strictObject({ vault: address, ...trade })),
  'vault.bounty': write('Fund vault automation bounty in raw bounty-token units.', z.strictObject({ vault: address, amount: rawAmount })),
  'intent.list': read('List management intents for a vault.', vault),
  'intent.show': read('Inspect a management intent and its activation time.', intent),
  'intent.execute': write('Execute an eligible management intent.', intent),
  'intent.cancel': write('Cancel a management intent if permitted on-chain.', intent),
  'rebalance.list': read('List rebalance/deposit/withdrawal intents for a vault or owner.', z.strictObject({ vault: address.optional(), owner: address.optional() }).refine(value => Boolean(value.vault) !== Boolean(value.owner), 'Specify exactly one of vault or owner')),
  'rebalance.show': read('Inspect settlement state and the next keeper action.', intent),
  'rebalance.cancel': write('Cancel a rebalance intent if allowed by the protocol.', intent),
  'rebalance.prices': write('Update oracle prices from on-chain feeds. Set refreshPyth=true to refresh Pyth through Hermes first.', z.strictObject({ intent: address, refreshPyth: z.boolean().default(false) })),
  'rebalance.mint': write('Mint vault shares after the deposit auction completes.', intent),
  'rebalance.redeem': write('Redeem underlying tokens after withdrawal or cancellation.', intent),
  'rebalance.claim-bounty': write('Claim earned keeper bounty after settlement.', intent),
  'fees.list': read('List fee withdrawal accounts for a vault.', vault),
  'fees.withdraw': write('Withdraw and claim fees owed to the signer.', vault),
  'fees.claim': write('Claim remaining tokens from a fee withdrawal account.', z.strictObject({ account: address })),
} as const;
export type CommandName = keyof typeof commands;
export type Action = { command: CommandName; input: unknown };
export type Input<N extends CommandName> = z.infer<(typeof commands)[N]['schema']>;
export function parse<N extends CommandName>(name: N, input: unknown): Input<N> { return commands[name].schema.parse(input) as Input<N>; }
export function catalog(name?: string) {
  if (name && !(name in commands)) throw new Error(`Unknown command: ${name}`);
  return Object.fromEntries(Object.entries(commands).filter(([key]) => !name || key === name).map(([key, value]) => [key, { description: value.description, effect: value.write ? 'prepare_transaction_plan' : 'read', inputSchema: z.toJSONSchema(value.schema, { io: 'input' }) }]));
}
