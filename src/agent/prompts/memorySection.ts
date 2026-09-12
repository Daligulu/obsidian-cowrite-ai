/** memory section（order=20）：命中的长期记忆 observation */
export const PROMPT_MEMORY_ORDER = 20;

export function memorySection(observations: string[]): { order: number; render: () => string } {
  return {
    order: PROMPT_MEMORY_ORDER,
    render: () => {
      if (!observations || observations.length === 0) return '';
      const lines = observations.map((o) => `- ${o}`).join('\n');
      return `## 你记住的关于这个用户的事\n${lines}\n`;
    },
  };
}
