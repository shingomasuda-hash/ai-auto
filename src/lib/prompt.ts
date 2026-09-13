/**
 * 管理コマンド用の入力読み取り。
 *
 * 対話（TTY）でもパイプ入力でも同じように動くようにする。
 * readline は EOF に達すると質問が解決しないまま終わるため、
 * パイプのときは標準入力を一度に読んで行に分ける。
 *
 * 値を引数に書かせないための仕組みなので、
 * 入力が足りないときは黙って進めず、必ずエラーにする。
 *
 * パスワードやトークンは画面へ表示しない。
 * 表示すると、肩越しに見えるだけでなく端末の履歴にも残る。
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export class MissingInputError extends Error {
  constructor(label: string) {
    super(`入力が足りません: ${label}`);
    this.name = 'MissingInputError';
  }
}

export class InputAbortedError extends Error {
  constructor() {
    super('入力が中断されました。');
    this.name = 'InputAbortedError';
  }
}

export type Prompter = {
  /** 通常の入力。画面に表示される。 */
  ask(label: string): Promise<string>;
  /** 秘密の入力。画面へ表示しない。 */
  askSecret(label: string): Promise<string>;
  close(): void;
};

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

const ENTER = ['\r', '\n'];
const BACKSPACE = ['\u0008', '\u007f'];
const CTRL_C = '\u0003';
const CTRL_D = '\u0004';

export type SecretKeyResult =
  /** まだ入力の途中。echo を画面へ出す。 */
  | { kind: 'continue'; echo: string }
  /** 入力が確定した。 */
  | { kind: 'done'; value: string }
  /** 中断された。 */
  | { kind: 'aborted' };

/**
 * 入力された文字を1つずつ処理する。画面へ出すのは伏せ字だけ。
 *
 * 端末に依存しない純粋な処理としてここに切り出し、テストできるようにする。
 * chars は呼び出し側が持つ蓄積用の配列で、この関数が書き換える。
 */
export function applySecretKey(chars: string[], char: string): SecretKeyResult {
  if (ENTER.includes(char)) return { kind: 'done', value: chars.join('') };
  if (char === CTRL_C || char === CTRL_D) return { kind: 'aborted' };
  if (BACKSPACE.includes(char)) {
    if (chars.length === 0) return { kind: 'continue', echo: '' };
    chars.pop();
    // 画面上の伏せ字を1つ消す
    return { kind: 'continue', echo: '\b \b' };
  }
  // 矢印キー等の制御文字は値に入れない
  if (char < ' ') return { kind: 'continue', echo: '' };
  chars.push(char);
  return { kind: 'continue', echo: '*' };
}

/**
 * 端末から1行読む。入力文字は画面へ出さず、長さだけを伏せ字で示す。
 *
 * readline の内部APIには触らず、生モードで1文字ずつ読む。
 */
function readSecretFromTty(label: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chars: string[] = [];
    const wasRaw = stdin.isRaw === true;

    const cleanup = () => {
      stdin.removeListener('data', onData);
      if (stdin.isTTY && !wasRaw) stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        const result = applySecretKey(chars, char);
        if (result.kind === 'done') {
          cleanup();
          resolve(result.value);
          return;
        }
        if (result.kind === 'aborted') {
          cleanup();
          reject(new InputAbortedError());
          return;
        }
        if (result.echo !== '') stdout.write(result.echo);
      }
    };

    stdout.write(`${label}: `);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}

export async function createPrompter(): Promise<Prompter> {
  if (stdin.isTTY) {
    let rl: ReturnType<typeof createInterface> | null = null;
    let closed = false;

    const ensureReadline = () => {
      if (!rl) {
        rl = createInterface({ input: stdin, output: stdout });
        rl.on('close', () => { closed = true; });
      }
      return rl;
    };

    return {
      async ask(label) {
        if (closed) throw new MissingInputError(label);
        const answer = await ensureReadline().question(`${label}: `);
        return answer.trim();
      },
      async askSecret(label) {
        // readline に読ませると入力が画面へ出てしまうので、生モードで読む。
        if (rl) {
          rl.close();
          rl = null;
          closed = false;
        }
        return (await readSecretFromTty(label)).trim();
      },
      close: () => {
        rl?.close();
        rl = null;
      },
    };
  }

  // パイプ入力: 1行につき1つの回答として扱う。画面へは何も出ない。
  const lines = (await readAllStdin()).split('\n');
  let index = 0;
  const next = (label: string): string => {
    if (index >= lines.length) throw new MissingInputError(label);
    const value = lines[index].trim();
    index += 1;
    return value;
  };
  return {
    async ask(label) { return next(label); },
    async askSecret(label) { return next(label); },
    close: () => {},
  };
}
