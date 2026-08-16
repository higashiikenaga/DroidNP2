// YM2608リズム波形ロードの実測ハーネス。
//
// NP2kai の sound/opna.c (opna_reset) は以下の順で fmgen を呼ぶ:
//   OPNA_Init(fmgen, OPNA_CLOCK*2, samplingrate, false, "")
//   getbiospath(path, "", ...)
//   OPNA_LoadRhythmSample(fmgen, path)
// このハーネスは同じ呼び出し順を再現し、その後リズムを鳴らすレジスタを実際に叩いて
// FM::OPNA::Mix() が出す PCM の絶対値和(absSum)を測る。
// 「LoadRhythmSample がエラーを返さない」ことではなく、「Mix の出力が本当に動く」ことだけを
// 合否判定の材料にする。呼び出し元(verify-rhythm-fmgen.mjs)側で、
// 波形を置かない陽性対照(絶対に absSum=0 になるはずのケース)と突き合わせて判定する。
//
// レジスタの意味は fmgen_opna.cpp の OPNA::SetReg / OPNA::RhythmMix を実際に読んで決めた:
//   reg 0x10: bit0-5 = 各楽器のKEY ON(bit7=0のとき) / KEY OFF+DUMP(bit7=1のとき、該当bitをOFF)
//   reg 0x11: rhythmtl = ~data & 63 (総合音量。data=0xFFで減衰0=最大音量)
//   reg 0x18-0x1D: 各楽器の level = ~data & 31 (data=0xFFで減衰0)、pan = (data>>6)&3 (0xFFで両ch出力)
// Init() は内部で SetVolumeRhythmTotal(0) / SetVolumeRhythm(*, 0) を呼ぶため、
// 追加の音量セッタ呼び出しは不要(既定値のままで減衰0)。reg 0x11 のみ明示的に最大化する。

#include "fmgen_opna.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <vector>

namespace {

const char* kNames[6] = {"BD", "SD", "TOP", "HH", "TOM", "RIM"};
const uint32 kOpnaClock = 3993600u;  // sound/opngen.h の OPNA_CLOCK

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: %s <rhythm_dir_with_trailing_slash>\n", argv[0]);
    return 2;
  }
  const char* dir = argv[1];

  FM::OPNA opna;
  // sound/opna.c と同じ順序: まず空パスでInit(内部でLoadRhythmSample("")が走るが結果は捨てる)。
  opna.Init(kOpnaClock * 2, 44100, false, "");
  // 本題: 検査対象ディレクトリを渡して読み直す。この戻り値だけを「読めたか」の判定に使う。
  const bool loaded = opna.LoadRhythmSample(dir);

  opna.SetReg(0x11, 0xFF);  // 総合音量: 減衰0
  for (int reg = 0x18; reg <= 0x1D; reg++) {
    opna.SetReg(reg, 0xFF);  // 各楽器の音量: 減衰0、パン: 両ch
  }

  const int kSamples = 100000;  // 44.1kHzで約2.3秒分。同梱波形(最長でも1秒未満)を確実に鳴らし切る長さ
  std::vector<FM::Sample> buf(static_cast<size_t>(kSamples) * 2);

  std::printf("{\"loaded\":%s,\"instruments\":[", loaded ? "true" : "false");
  for (int i = 0; i < 6; i++) {
    std::fill(buf.begin(), buf.end(), 0);

    opna.SetReg(0x10, static_cast<uint>(1 << i));  // 該当楽器のみ KEY ON
    opna.Mix(buf.data(), kSamples);
    opna.SetReg(0x10, 0x80 | static_cast<uint>(1 << i));  // DUMP: 次の楽器へ持ち越さない

    int64_t absSum = 0;
    for (FM::Sample s : buf) {
      absSum += s < 0 ? -static_cast<int64_t>(s) : static_cast<int64_t>(s);
    }

    std::printf("%s{\"name\":\"%s\",\"absSum\":%lld}", i ? "," : "", kNames[i],
                static_cast<long long>(absSum));
  }
  std::printf("]}\n");
  return 0;
}
