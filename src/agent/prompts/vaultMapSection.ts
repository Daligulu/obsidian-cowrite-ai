/** vault map section（order=10）：与当前任务相关的笔记地图 */
export const PROMPT_VAULT_MAP_ORDER = 10;

export function vaultMapSection(vaultMapText: string): { order: number; render: () => string } {
  return {
    order: PROMPT_VAULT_MAP_ORDER,
    render: () => (vaultMapText ? vaultMapText + '\n' : ''),
  };
}
