import { PublicKey } from '@solana/web3.js';
import type { GlobalConfig, Vault } from '@symmetry-hq/sdk';
import { MINTS } from '@symmetry-hq/sdk/dist/constants.js';
import { RebalanceType } from '@symmetry-hq/sdk/dist/layouts/intents/rebalanceIntent.js';
import { computeRebalanceIntentBountyAmount } from '@symmetry-hq/sdk/dist/states/intents/rebalanceIntent.js';
import { CliError } from './lib/utils.js';

// Validate the exact calculation used by the pinned SDK before it encodes lamports.
export function validateBountyAmount(global: GlobalConfig, vault: Vault, type: RebalanceType, owner: string, contribution = '0') {
  if (!global.bountyMint.equals(MINTS.mainnet!.WSOL!)) return;
  const values = [global.bountyBondAmount, global.bountyPerTask.maxBounty, global.bountyPerPriceUpdateTaskDivisor].map(value => Number(value.toString()));
  if (values.some(value => !Number.isSafeInteger(value)) || values[2]! <= 0) throw new CliError('SDK_BOUNTY_UNSUPPORTED', 'SDK bounty configuration exceeds its exact integer range.');
  const amount = computeRebalanceIntentBountyAmount(type, vault.numTokens, values[0]!, values[1]!, Math.floor(values[1]! / values[2]!));
  if (!Number.isSafeInteger(amount)) throw new CliError('SDK_BOUNTY_UNSUPPORTED', 'The computed bounty exceeds the SDK exact integer range.');
  let total = BigInt(amount) + BigInt(contribution);
  if (type === RebalanceType.Vault && [vault.settings.creator, ...vault.settings.managers.managers].some(key => key.equals(new PublicKey(owner)))) {
    const minimum = BigInt(global.minBountyForVaultAutomation.toString()), current = BigInt(vault.settings.bountyBalance.toString());
    if (current < minimum) total += 2n * minimum - current;
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new CliError('AMOUNT_TOO_LARGE', 'Combined SOL contribution and bounty exceed the SDK exact integer range.');
}
