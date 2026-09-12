/** current note section（order=30）：当前打开笔记的元信息 */
export const PROMPT_CURRENT_NOTE_ORDER = 30;

export interface CurrentNoteInfo {
  path: string;
  basename: string;
}

export function currentNoteSection(note: CurrentNoteInfo | null): { order: number; render: () => string } {
  return {
    order: PROMPT_CURRENT_NOTE_ORDER,
    render: () => {
      if (!note) return '';
      return `## 当前打开的笔记\n路径：${note.path}\n文件名：${note.basename}\n`;
    },
  };
}
