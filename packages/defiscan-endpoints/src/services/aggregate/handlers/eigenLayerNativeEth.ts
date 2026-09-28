import type { EthereumAddress } from '@l2beat/shared-pure'
import type { AggregateResponse } from '../../../types/api'
import type { AggregateHandler } from './types'

// DeFiLlama tracks EigenLayer under the "eigenlayer" slug.
// Its `tokensInUsd` breakdown separates native ETH (WETH) from LSTs.
// We extract only WETH because the LST portion is already captured
// by fetchBalances on the individual StrategyBaseTVLLimits contracts.
const DEFILLAMA_SLUG = 'eigenlayer'

interface DefiLlamaProtocolResponse {
  name?: string
  tokensInUsd?: Array<{ date: number; tokens: Record<string, number> }>
}

/**
 * Aggregate handler for EigenLayer native ETH restaking via EigenPods.
 *
 * Data source: DeFiLlama protocol API (`/protocol/eigenlayer`), WETH token entry.
 *
 * Why WETH only? DeFiLlama decomposes EigenLayer TVL by token. WETH represents
 * ETH that validators have restaked by pointing their withdrawal credentials to
 * EigenPods. This ETH lives in the Ethereum beacon chain — not in any on-chain
 * ERC-20 balance that fetchBalances can read. The LST tokens (stETH, ETHx, etc.)
 * appear in the same DeFiLlama breakdown but are already captured by fetchBalances
 * on the StrategyBaseTVLLimits proxy contracts. Adding them here would double-count.
 */
export class EigenLayerNativeEthHandler implements AggregateHandler {
  name = 'eigenlayer-native-eth'

  async fetch(
    contractAddress: EthereumAddress,
    _chain: string,
  ): Promise<AggregateResponse> {
    const url = `https://api.llama.fi/protocol/${DEFILLAMA_SLUG}`
    const response = await fetch(url)

    if (!response.ok) {
      throw new Error(
        `DeFiLlama API returned ${response.status}: ${await response.text()}`,
      )
    }

    const data = (await response.json()) as DefiLlamaProtocolResponse

    // Use the most recent tokensInUsd snapshot. Fail loudly if the WETH entry
    // is missing, so a DeFiLlama format change can't silently zero ~all of TVS.
    const latest = (data.tokensInUsd ?? []).at(-1)
    const wethUsd = latest?.tokens?.['WETH']
    if (typeof wethUsd !== 'number' || !Number.isFinite(wethUsd)) {
      throw new Error(
        `DeFiLlama ${DEFILLAMA_SLUG} response has no WETH entry in the latest tokensInUsd snapshot`,
      )
    }

    return {
      contract_address: contractAddress.toString(),
      total_usd_value: wethUsd,
      contract_count: 0,
      breakdown: [],
      timestamp: new Date().toISOString(),
      source: `defillama-${DEFILLAMA_SLUG}-native-eth`,
    }
  }
}
