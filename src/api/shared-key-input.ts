// 複数の入力元(物理キーボード・ゲームパッド等)から同じPC-98キーが同時に押されうる状況を
// 参照カウントで束ねる。ある入力元が離しても、他の入力元がまだ押していればコアへbreak
// (キーアップ)を送らない。WebX68k の virtual-keyboard.ts から SharedKeyInput のみを
// 抜き出したもの(retrok(libretroキーコード)は使わないため、引数名は code = PC-98スキャンコードに改名)。

/** 複数入力元が同じPC-98キーコードを押した場合、最後の入力元が離すまでコアへbreakを送らない。 */
export class SharedKeyInput {
  private readonly sources = new Map<string, Set<number>>();
  private readonly counts = new Map<number, number>();

  constructor(private readonly output: (code: number, down: boolean) => void) {}

  press(source: string, code: number): void {
    let keys = this.sources.get(source);
    if (!keys) {
      keys = new Set<number>();
      this.sources.set(source, keys);
    }
    if (keys.has(code)) return;
    keys.add(code);
    const count = this.counts.get(code) ?? 0;
    this.counts.set(code, count + 1);
    if (count === 0) this.output(code, true);
  }

  release(source: string, code: number): void {
    const keys = this.sources.get(source);
    if (!keys?.delete(code)) return;
    const count = this.counts.get(code) ?? 0;
    if (count <= 1) {
      this.counts.delete(code);
      this.output(code, false);
    } else {
      this.counts.set(code, count - 1);
    }
    if (keys.size === 0) this.sources.delete(source);
  }

  releaseSource(source: string): void {
    for (const code of [...(this.sources.get(source) ?? [])]) this.release(source, code);
  }

  releaseAll(): void {
    for (const source of [...this.sources.keys()]) this.releaseSource(source);
  }
}
