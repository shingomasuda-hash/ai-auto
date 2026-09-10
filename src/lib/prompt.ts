/**
 * 管理コマンド用の入力読み取り。
 *
 * 対話（TTY）でもパイプ入力でも同じように動くようにする。
 * readline は EOF に達すると質問が解決しないまま終わるため、
 * パイプのときは標準入力を一度に読んで行に分ける。
 *
 * 値を引数に書かせないための仕組みなので、
 * 入力が足りないときは黙って進めず、必ずエラーにする。
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export class MissingInputError extends Error {
  constructor(label: string) {
    super(`入力が足りません: ${label}`);
    this.name = 'MissingInputError';
  }
}

export type Prompter = {
  ask(label: string): Promise<string>;
  close(): void;
};

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function createPrompter(): Promise<Prompter> {
  if (stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout });
    let closed = false;
    rl.on('close', () => { closed = true; });
    return {
      async ask(label) {
        if (closed) throw new MissingInputError(label);
        const answer = await rl.question(`${label}: `);
        return answer.trim();
      },
      close: () => rl.close(),
    };
  }

  // パイプ入力: 1行につき1つの回答として扱う。
  const lines = (await readAllStdin()).split('\n');
  let index = 0;
  return {
    async ask(label) {
      if (index >= lines.length) throw new MissingInputError(label);
      const value = lines[index].trim();
      index += 1;
      return value;
    },
    close: () => {},
  };
}
