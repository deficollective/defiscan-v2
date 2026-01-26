import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { getProject, updateContractTag, updateFunction } from '../api/api'
import type {
  AdminDetailWithCapital,
  AdminModuleScore,
  ApiAddressType,
  FunctionCapitalAnalysis,
  Impact,
  LetterGrade,
  Likelihood,
} from '../api/types'
import { ProxyTypeTag } from '../apps/discovery/defidisco/ProxyTypeTag'
import { buildProxyTypeMap } from '../apps/discovery/defidisco/proxyTypeUtils'
import { usePanelStore } from '../apps/discovery/store/panel-store'
import { useContractTags } from '../hooks/useContractTags'

/**
 * Format USD value for display
 */
function formatUsdValue(value: number): string {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`
  }
  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(2)}K`
  }
  if (value > 0) {
    return `$${value.toFixed(2)}`
  }
  return '$0'
}

/**
 * Check if admin has capital data
 */
function hasCapitalData(admin: any): admin is AdminDetailWithCapital {
  return (
    'totalReachableCapital' in admin &&
    typeof admin.totalReachableCapital === 'number'
  )
}

interface AdminsInventoryBreakdownProps {
  score: AdminModuleScore
}

/**
 * Get semantic color class for a letter grade
 */
function getGradeColor(grade: LetterGrade): string {
  switch (grade) {
    case 'AAA':
    case 'AA':
    case 'A':
      return 'text-green-400'
    case 'BBB':
    case 'BB':
    case 'B':
      return 'text-yellow-400'
    case 'CCC':
    case 'CC':
    case 'C':
      return 'text-orange-400'
    case 'D':
      return 'text-red-400'
  }
}

/**
 * Get inline styles for grade badge
 */
function getGradeBadgeStyles(grade: LetterGrade): {
  backgroundColor: string
  borderColor: string
  color: string
} {
  switch (grade) {
    case 'AAA':
    case 'AA':
    case 'A':
      return {
        backgroundColor: 'rgba(20, 83, 45, 0.5)', // green-900/50
        borderColor: 'rgba(34, 197, 94, 0.3)', // green-500/30
        color: '#4ade80', // green-400
      }
    case 'BBB':
    case 'BB':
    case 'B':
      return {
        backgroundColor: 'rgba(113, 63, 18, 0.5)', // yellow-900/50
        borderColor: 'rgba(234, 179, 8, 0.3)', // yellow-500/30
        color: '#facc15', // yellow-400
      }
    case 'CCC':
    case 'CC':
    case 'C':
      return {
        backgroundColor: 'rgba(124, 45, 18, 0.5)', // orange-900/50
        borderColor: 'rgba(249, 115, 22, 0.3)', // orange-500/30
        color: '#fb923c', // orange-400
      }
    case 'D':
      return {
        backgroundColor: 'rgba(127, 29, 29, 0.5)', // red-900/50
        borderColor: 'rgba(239, 68, 68, 0.3)', // red-500/30
        color: '#f87171', // red-400
      }
  }
}

/**
 * Get color value for admin type (inline style)
 */
function getAdminTypeColor(type: ApiAddressType): string {
  switch (type) {
    case 'EOA':
    case 'EOAPermissioned':
      return '#f87171' // red-400 (high risk)
    case 'Multisig':
      return '#fbbf24' // yellow-400 (medium risk)
    case 'Timelock':
      return '#10b981' // green-500 (lower risk)
    case 'Contract':
    case 'Diamond':
      return '#60a5fa' // blue-400 (depends on implementation)
    default:
      return '#9ca3af' // gray-400
  }
}

/**
 * Get color value for impact level (inline style)
 */
function getImpactColor(impact: string): string {
  switch (impact) {
    case 'critical':
      return '#c084fc' // purple-400
    case 'high':
      return '#f87171' // red-400
    case 'medium':
      return '#fbbf24' // yellow-400
    case 'low':
      return '#10b981' // green-500
    default:
      return '#9ca3af' // gray-400
  }
}

/**
 * Get color value for likelihood level (inline style)
 */
function getLikelihoodColor(likelihood: string): string {
  switch (likelihood) {
    case 'high':
      return '#f87171' // red-400
    case 'medium':
      return '#fb923c' // orange-400
    case 'low':
      return '#10b981' // green-500
    case 'mitigated':
      return '#60a5fa' // blue-400
    default:
      return '#9ca3af' // gray-400 (unassigned)
  }
}

/**
 * Convert Impact to score string for API
 */
function impactToScore(
  impact: Impact,
): 'low-risk' | 'medium-risk' | 'high-risk' | 'critical' {
  switch (impact) {
    case 'low':
      return 'low-risk'
    case 'medium':
      return 'medium-risk'
    case 'high':
      return 'high-risk'
    case 'critical':
      return 'critical'
  }
}

/**
 * Impact inline editor dropdown
 */
function ImpactPicker({
  currentImpact,
  onUpdate,
}: {
  currentImpact: Impact
  onUpdate: (impact: Impact) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const impactOptions: Impact[] = ['low', 'medium', 'high', 'critical']

  const handleSelect = (impact: Impact) => {
    onUpdate(impact)
    setIsOpen(false)
  }

  return (
    <div className="relative inline-block">
      <button
        onClick={(e) => {
          e.stopPropagation()
          setIsOpen(!isOpen)
        }}
        className="rounded border border-coffee-600 bg-coffee-700 px-2 py-0.5 text-xs capitalize hover:bg-coffee-600"
        style={{ color: getImpactColor(currentImpact) }}
      >
        {currentImpact}
      </button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute right-0 z-50 mt-1 flex min-w-[120px] flex-col gap-2 rounded border border-coffee-600 bg-coffee-800 p-2 shadow-xl">
            <div className="font-semibold text-coffee-300 text-xs">Impact</div>
            {impactOptions.map((imp) => (
              <button
                key={imp}
                className={`rounded border border-coffee-600 px-2 py-1 text-xs capitalize ${
                  currentImpact === imp
                    ? 'bg-coffee-600'
                    : 'bg-coffee-700 hover:bg-coffee-600'
                }`}
                onClick={() => handleSelect(imp)}
              >
                {imp}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Likelihood inline editor dropdown (with optional unscored state)
 */
function LikelihoodPicker({
  currentLikelihood,
  onUpdate,
  allowUnscored = false,
}: {
  currentLikelihood?: Likelihood
  onUpdate: (likelihood: Likelihood) => void
  allowUnscored?: boolean
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [selectedLikelihood, setSelectedLikelihood] = useState<Likelihood>(
    currentLikelihood || 'high',
  )
  const likelihoodOptions: Likelihood[] = ['high', 'medium', 'low', 'mitigated']

  // Sync internal state when prop changes
  useEffect(() => {
    if (currentLikelihood) {
      setSelectedLikelihood(currentLikelihood)
    }
  }, [currentLikelihood])

  const handleApply = () => {
    onUpdate(selectedLikelihood)
    setIsOpen(false)
  }

  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation()
    setIsOpen(!isOpen)
  }

  const displayText =
    allowUnscored && !currentLikelihood ? 'unscored' : currentLikelihood
  const displayColor =
    allowUnscored && !currentLikelihood
      ? '#9ca3af'
      : getLikelihoodColor(currentLikelihood || 'high')

  return (
    <div className="relative inline-block">
      <button
        onClick={handleOpen}
        className="rounded border border-coffee-600 bg-coffee-700 px-2 py-0.5 text-xs capitalize hover:bg-coffee-600"
        style={{ color: displayColor }}
      >
        {displayText}
      </button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute right-0 z-50 mt-1 flex min-w-[120px] flex-col gap-2 rounded border border-coffee-600 bg-coffee-800 p-2 shadow-xl">
            <div className="font-semibold text-coffee-300 text-xs">
              Likelihood
            </div>
            {likelihoodOptions.map((lik) => (
              <button
                key={lik}
                className={`rounded border border-coffee-600 px-2 py-1 text-xs capitalize ${
                  selectedLikelihood === lik
                    ? 'bg-coffee-600'
                    : 'bg-coffee-700 hover:bg-coffee-600'
                }`}
                onClick={() => setSelectedLikelihood(lik)}
              >
                {lik}
              </button>
            ))}
            <button
              className="w-full rounded border border-coffee-600 bg-coffee-700 px-2 py-1 text-xs hover:bg-coffee-600"
              onClick={handleApply}
            >
              Apply
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Check if an address is the zero address (permission revoked)
 */
function isZeroAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace('eth:', '')
  return normalized === '0x0000000000000000000000000000000000000000'
}

// Tree structure constants
const TREE_BRANCH = '├──'
const TREE_LAST = '└──'
const TREE_PIPE = '│  '
const TREE_SPACE = '   '

/**
 * Tree node component for consistent styling
 */
function TreeNode({
  prefix,
  children,
  onClick,
  className = '',
}: {
  prefix: string
  children: React.ReactNode
  onClick?: () => void
  className?: string
}) {
  return (
    <div className={`flex items-start font-mono text-xs ${className}`}>
      <span className="mr-1 whitespace-pre text-coffee-600">{prefix}</span>
      {onClick ? (
        <button
          onClick={onClick}
          className="text-left transition-colors hover:text-blue-400"
        >
          {children}
        </button>
      ) : (
        <span>{children}</span>
      )}
    </div>
  )
}

/**
 * Funds display component - subtle text styling to match theme
 */
function FundsDisplay({ value }: { value: number }) {
  if (value <= 0) return null
  return (
    <span className="mr-1.5 text-coffee-400">
      {formatUsdValue(value)}
    </span>
  )
}

/**
 * Capital breakdown section - shows detailed breakdown for a function using tree structure
 */
function FunctionCapitalBreakdown({
  analysis,
  isLastFunction,
  parentPrefix,
}: {
  analysis: FunctionCapitalAnalysis
  isLastFunction: boolean
  parentPrefix: string
}) {
  const [isExpanded, setIsExpanded] = useState(true)
  const selectGlobal = usePanelStore((state) => state.select)

  // Split by fundsAtRisk status
  const contractsAtRisk = analysis.reachableContracts.filter(
    (c) => c.fundsAtRisk,
  )
  const contractsNotAtRisk = analysis.reachableContracts.filter(
    (c) => !c.fundsAtRisk,
  )

  // If no reachable contracts, don't show tree - total is already in function row
  const hasReachable =
    contractsAtRisk.length > 0 || contractsNotAtRisk.length > 0
  if (!hasReachable) return null

  // Continuation prefix for children
  const childPrefix = parentPrefix + (isLastFunction ? TREE_SPACE : TREE_PIPE)

  return (
    <div className="font-mono text-xs">
      {/* Direct contract as clickable root */}
      <div
        className="flex cursor-pointer items-start transition-colors hover:text-coffee-200"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span className="mr-1 whitespace-pre text-coffee-600">
          {childPrefix}
          {TREE_LAST}
        </span>
        <span className="flex items-center gap-1">
          <FundsDisplay value={analysis.directFundsUsd} />
          <button
            onClick={(e) => {
              e.stopPropagation()
              selectGlobal(analysis.contractAddress)
            }}
            className="text-coffee-200 transition-colors hover:text-blue-400"
          >
            {analysis.contractName}
          </button>
          {analysis.unresolvedCallsCount > 0 && (
            <span className="text-yellow-500">
              (+{analysis.unresolvedCallsCount} unresolved)
            </span>
          )}
          <span className="text-coffee-600">{isExpanded ? '▼' : '▶'}</span>
        </span>
      </div>

      {/* Expanded details - reachable contracts */}
      {isExpanded && (
        <div>
          {/* Reachable contracts at risk */}
          {contractsAtRisk.map((contract, idx) => {
            const isLast =
              idx === contractsAtRisk.length - 1 &&
              contractsNotAtRisk.length === 0
            return (
              <TreeNode
                key={contract.contractAddress}
                prefix={`${childPrefix}${TREE_SPACE}${isLast ? TREE_LAST : TREE_BRANCH}`}
                onClick={() => selectGlobal(contract.contractAddress)}
                className={
                  contract.viewOnlyPath ? 'text-coffee-400' : 'text-coffee-200'
                }
              >
                <FundsDisplay value={contract.fundsUsd} />
                <span>{contract.contractName}</span>
                {contract.viewOnlyPath && (
                  <span className="ml-1 text-coffee-600 italic">
                    (view-only)
                  </span>
                )}
                {contract.calledFunctions &&
                  contract.calledFunctions.length > 0 && (
                    <span className="ml-1 text-coffee-500">
                      → {contract.calledFunctions.join(', ')}
                    </span>
                  )}
              </TreeNode>
            )
          })}

          {/* Reachable contracts not at risk (unscored) */}
          {contractsNotAtRisk.length > 0 && (
            <>
              <TreeNode
                prefix={`${childPrefix}${TREE_SPACE}${TREE_BRANCH}`}
                className="text-coffee-600"
              >
                Unscored (not counted):
              </TreeNode>
              {contractsNotAtRisk.map((contract, idx) => {
                const isLast = idx === contractsNotAtRisk.length - 1
                return (
                  <TreeNode
                    key={contract.contractAddress}
                    prefix={`${childPrefix}${TREE_SPACE}${TREE_PIPE}${isLast ? TREE_LAST : TREE_BRANCH}`}
                    onClick={() => selectGlobal(contract.contractAddress)}
                    className="text-coffee-600"
                  >
                    {contract.fundsUsd > 0 && (
                      <span className="mr-1 text-coffee-600 line-through">
                        {formatUsdValue(contract.fundsUsd)}
                      </span>
                    )}
                    <span>{contract.contractName}</span>
                    {contract.calledFunctions &&
                      contract.calledFunctions.length > 0 && (
                        <span className="ml-1">
                          → {contract.calledFunctions.join(', ')}
                        </span>
                      )}
                  </TreeNode>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Admin section component - displays functions for a single admin address
 */
function AdminSection({
  admin,
  proxyType,
  onUpdateLikelihood,
  onUpdateImpact,
}: {
  admin: any
  proxyType?: string
  onUpdateLikelihood: (adminAddress: string, likelihood: Likelihood) => void
  onUpdateImpact: (
    contractAddress: string,
    functionName: string,
    impact: Impact,
  ) => void
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const selectGlobal = usePanelStore((state) => state.select)
  const isRevoked = isZeroAddress(admin.adminAddress)

  // Get capital analysis map for quick lookup
  const capitalMap = useMemo(() => {
    if (!hasCapitalData(admin))
      return new Map<string, FunctionCapitalAnalysis>()
    return new Map(
      admin.functionsWithCapital.map((fc: FunctionCapitalAnalysis) => [
        `${fc.contractAddress}:${fc.functionName}`,
        fc,
      ]),
    )
  }, [admin])

  // Calculate worst grade among all functions for this admin
  const worstGrade =
    admin.functions.length > 0 && admin.likelihood
      ? admin.functions
          .filter((func: any) => func.grade) // Only consider functions with grades
          .reduce(
            (worst: LetterGrade | null, func: any) => {
              if (!worst) return func.grade
              const gradeValues: Record<LetterGrade, number> = {
                AAA: 10,
                AA: 9,
                A: 8,
                BBB: 7,
                BB: 6,
                B: 5,
                CCC: 4,
                CC: 3,
                C: 2,
                D: 1,
              }
              return gradeValues[func.grade] < gradeValues[worst]
                ? func.grade
                : worst
            },
            null as LetterGrade | null,
          )
      : null

  const badgeStyles = worstGrade ? getGradeBadgeStyles(worstGrade) : null

  return (
    <div className="mb-2 ml-4">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 rounded p-2 text-left transition-colors hover:bg-coffee-800/30"
      >
        <span className="text-coffee-400 text-xs">
          {isExpanded ? '▼' : '▶'}
        </span>
        {badgeStyles && (
          <span
            className="inline-block rounded border px-2 py-0.5 font-mono text-xs"
            style={{
              backgroundColor: badgeStyles.backgroundColor,
              borderColor: badgeStyles.borderColor,
              color: badgeStyles.color,
            }}
          >
            {worstGrade}
          </span>
        )}
        {isRevoked ? (
          <span
            className="inline-block rounded border px-1.5 py-0.5 font-semibold text-xs"
            style={{
              color: '#10b981', // green-500
              borderColor: '#10b98140',
              backgroundColor: 'rgba(16, 185, 129, 0.1)',
            }}
          >
            Revoked
          </span>
        ) : (
          <span
            className="inline-block rounded border px-1.5 py-0.5 text-xs capitalize"
            style={{
              color: getAdminTypeColor(admin.adminType),
              borderColor: getAdminTypeColor(admin.adminType) + '40',
            }}
          >
            {admin.adminType}
          </span>
        )}
        <ProxyTypeTag proxyType={proxyType} />
        <button
          onClick={(e) => {
            e.stopPropagation()
            if (!isRevoked) selectGlobal(admin.adminAddress)
          }}
          className={`font-medium text-sm ${isRevoked ? 'cursor-default text-coffee-400' : 'cursor-pointer text-coffee-200 transition-colors hover:text-blue-400'}`}
        >
          {isRevoked ? '0x0000...0000' : admin.adminName}
        </button>
        <span className="mx-1 text-coffee-500 text-xs">|</span>
        <span className="text-coffee-400 text-xs">Likelihood:</span>
        <LikelihoodPicker
          currentLikelihood={admin.likelihood}
          onUpdate={(likelihood) =>
            onUpdateLikelihood(admin.adminAddress, likelihood)
          }
          allowUnscored={true}
        />
        <span className="ml-2 text-coffee-400 text-xs">
          ({admin.functions.length} function
          {admin.functions.length !== 1 ? 's' : ''})
        </span>
        {/* Capital at risk display */}
        {hasCapitalData(admin) && admin.totalReachableCapital > 0 && (
          <>
            <span className="mx-1 text-coffee-500 text-xs">|</span>
            <span className="font-medium text-green-400 text-xs">
              {formatUsdValue(admin.totalReachableCapital)} at risk
            </span>
            <span className="ml-1 text-coffee-500 text-xs">
              ({admin.uniqueContractsAffected} contract
              {admin.uniqueContractsAffected !== 1 ? 's' : ''})
            </span>
          </>
        )}
      </button>

      {isExpanded && (
        <div className="mt-2 ml-6">
          {admin.functions.map((func: any, idx: number) => {
            const isLastFunc = idx === admin.functions.length - 1
            const gradeBadgeStyles = func.grade
              ? getGradeBadgeStyles(func.grade)
              : null
            const capitalAnalysis = capitalMap.get(
              `${func.contractAddress}:${func.functionName}`,
            )

            const treePrefix = isLastFunc ? TREE_LAST : TREE_BRANCH

            // Calculate total funds for this function
            const totalFundsForFunc = capitalAnalysis
              ? capitalAnalysis.directFundsUsd +
                capitalAnalysis.totalReachableFundsUsd
              : 0

            return (
              <div key={idx} className="text-coffee-300">
                {/* Function row with tree prefix */}
                <div className="flex items-center font-mono text-xs">
                  <span className="mr-1 whitespace-pre text-coffee-600">
                    {treePrefix}
                  </span>
                  {gradeBadgeStyles ? (
                    <span
                      className="mr-1.5 inline-block rounded border px-1.5 py-0.5 text-xs"
                      style={{
                        backgroundColor: gradeBadgeStyles.backgroundColor,
                        borderColor: gradeBadgeStyles.borderColor,
                        color: gradeBadgeStyles.color,
                      }}
                    >
                      {func.grade}
                    </span>
                  ) : (
                    <span className="mr-1.5 inline-block px-1.5 py-0.5 text-coffee-500 text-xs">
                      -
                    </span>
                  )}
                  {/* Funds display after grade */}
                  {totalFundsForFunc > 0 && (
                    <span className="mr-1.5 text-coffee-400">
                      {formatUsdValue(totalFundsForFunc)}
                    </span>
                  )}
                  <button
                    onClick={() => selectGlobal(func.contractAddress)}
                    className="cursor-pointer text-coffee-200 transition-colors hover:text-blue-400"
                  >
                    {func.contractName}
                  </button>
                  <span className="text-coffee-500">.</span>
                  <span className="text-blue-400">{func.functionName}()</span>
                  <span className="ml-2 text-coffee-500">(</span>
                  <ImpactPicker
                    currentImpact={func.impact}
                    onUpdate={(impact) =>
                      onUpdateImpact(
                        func.contractAddress,
                        func.functionName,
                        impact,
                      )
                    }
                  />
                  <span className="text-coffee-500">)</span>
                </div>
                {/* Capital breakdown for this function - uses tree structure */}
                {capitalAnalysis && (
                  <FunctionCapitalBreakdown
                    analysis={capitalAnalysis}
                    isLastFunction={isLastFunc}
                    parentPrefix=""
                  />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Admins Inventory Breakdown Component
 * Displays breakdown of admins by address
 */
export function AdminsInventoryBreakdown({
  score,
}: AdminsInventoryBreakdownProps) {
  const { project } = useParams()
  const queryClient = useQueryClient()
  const { data: contractTags } = useContractTags(project!)
  const gradeColor = getGradeColor(score.grade)

  // Fetch project data for proxy type information
  const { data: projectData } = useQuery({
    queryKey: ['projects', project],
    queryFn: () => getProject(project!),
    enabled: !!project,
  })

  // Build proxy type lookup map
  const proxyTypeMap = useMemo(
    () => buildProxyTypeMap(projectData),
    [projectData],
  )

  // Mutation for updating likelihood
  const updateLikelihoodMutation = useMutation({
    mutationFn: ({
      adminAddress,
      likelihood,
    }: {
      adminAddress: string
      likelihood: Likelihood
    }) => {
      if (!project) throw new Error('Project not found')

      // Get existing tag to preserve other attributes
      // IMPORTANT: Keep the eth: prefix for matching!
      const existingTag = contractTags?.tags.find(
        (tag) =>
          tag.contractAddress.toLowerCase() === adminAddress.toLowerCase(),
      )

      return updateContractTag(project, {
        contractAddress: adminAddress,
        isExternal: existingTag?.isExternal ?? false,
        centralization: existingTag?.centralization,
        likelihood: likelihood,
      })
    },
    onSuccess: () => {
      // Invalidate queries to refetch data
      queryClient.invalidateQueries({ queryKey: ['contract-tags', project] })
      queryClient.invalidateQueries({ queryKey: ['v2-score', project] })
    },
  })

  const handleUpdateLikelihood = (
    adminAddress: string,
    likelihood: Likelihood,
  ) => {
    updateLikelihoodMutation.mutate({ adminAddress, likelihood })
  }

  // Mutation for updating impact
  const updateImpactMutation = useMutation({
    mutationFn: ({
      contractAddress,
      functionName,
      impact,
    }: {
      contractAddress: string
      functionName: string
      impact: Impact
    }) => {
      if (!project) throw new Error('Project not found')

      return updateFunction(project, {
        contractAddress,
        functionName,
        score: impactToScore(impact),
      })
    },
    onSuccess: () => {
      // Invalidate queries to refetch data
      queryClient.invalidateQueries({ queryKey: ['functions', project] })
      queryClient.invalidateQueries({ queryKey: ['v2-score', project] })
    },
  })

  const handleUpdateImpact = (
    contractAddress: string,
    functionName: string,
    impact: Impact,
  ) => {
    updateImpactMutation.mutate({ contractAddress, functionName, impact })
  }

  // Count functions across all admins
  const totalFunctionCount = score.breakdown
    ? score.breakdown.reduce((sum, admin) => sum + admin.functions.length, 0)
    : 0

  return (
    <div className="text-coffee-300">
      {/* Main header - non-expandable, consistent with other inventory items */}
      <div className="flex items-center justify-between">
        <span className="font-medium">
          Admins:
          {score.totalCapitalAtRisk !== undefined &&
            score.totalCapitalAtRisk > 0 && (
              <span className="ml-2 font-normal text-green-400 text-sm">
                {formatUsdValue(score.totalCapitalAtRisk)} at risk
              </span>
            )}
        </span>
        <span>
          {score.inventory}{' '}
          <span className={`font-semibold ${gradeColor}`}>
            (Grade: {score.grade})
          </span>
        </span>
      </div>

      {/* Admin breakdown - always shown */}
      <div className="mt-3 ml-2">
        {!score.breakdown || score.breakdown.length === 0 ? (
          <p className="ml-4 text-coffee-400 text-xs">
            No permission owners found
          </p>
        ) : (
          <>
            <p className="mb-3 ml-4 text-coffee-400 text-xs">
              {totalFunctionCount} permissioned function
              {totalFunctionCount !== 1 ? 's' : ''} controlled by{' '}
              {score.breakdown.length} admin
              {score.breakdown.length !== 1 ? 's' : ''}
            </p>
            {score.breakdown.map((admin) => (
              <AdminSection
                key={admin.adminAddress}
                admin={admin}
                proxyType={proxyTypeMap.get(admin.adminAddress.toLowerCase())}
                onUpdateLikelihood={handleUpdateLikelihood}
                onUpdateImpact={handleUpdateImpact}
              />
            ))}
          </>
        )}
      </div>
    </div>
  )
}
