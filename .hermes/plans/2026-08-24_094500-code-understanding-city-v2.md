# Code Understanding City v2 — 実装全体像

> system-mapを「見て楽しむ街」から「触って回るだけでコードベースが理解できる街」へ。
> inkboard/system-atlas の文法（読める地図・Steps実行・テキスト双子）を、本物のコード解析データの上に載せる。

**Goal:** ビル（ファイル）→関数を選ぶと atlas 文法のパネルで何者か分かり、その関数の呼び出し連鎖が実際のワイヤ上をパケットが歩いて見える。加えて街全体の要約が `CITY.md` として自動生成され、エージェントが作業前に読める。

**Architecture:** 4レイヤー。L1 データ(extract v2) → L2 構造UI(パネルv2) → L3 運動(ステップウォーク+常時パケット) → L4 意味(insights/CITY.md)。各層は独立して価値がある。ゼロ依存Node維持、出力は単一自己完結HTML。

**Tech Stack:** Node標準ライブラリのみ / three.js(ビルド時にバンドル) / 既存qa.mjs(Playwright) / LLMバッチのみClaude Code (claude -p, Max枠)

---

## データ契約（SSOT）

### city.json v2（extract.mjs出力に追加）

```jsonc
{
  nodes: [{
    id, kind, district, loc, bytes, deps, exports, fanIn, syms,   // 既存
    symbols: [{ n, k, line, endLine }]                             // NEW: 行範囲
  }],
  edges: [...],                                                    // 既存（ファイル間import）
  calls: [                                                         // NEW: リポ内呼び出しグラフ
    { f: "src/app/page.tsx", fs: "handleSubmit", t: "src/lib/api.ts", ts: "searchPlaces" }
  ]
}
```

- **呼び出し抽出の規律**: 抽出済みシンボル表に存在する名前だけ採用（偽陽性抑制）。上限1000件、超過はfan-in上位を残して切り捨て
- 限界は明記: ダイナミックディスパッチ・再エクスポート・文字列参照は追えない

### insights.json（新・キャッシュファイル。renderには渡さずrender3dが読む）

```jsonc
{
  "src/lib/tags.ts::normalizeTags": { one: "タグ表記を正規化する。", what: "…" },
  "_file/src/app/api":             { one: "…" }        // ファイル/区画レベルも可
}
```

- エントリに `gen`(生成元)とdateを持たせ、手書き上書きを許す（LLM案→人間が直せる）

### CITY.md（新・生成物。render3dと同じcity.json+insightsから吐く）

街の要約: 区画表・最hotビル(fan-in上位)・孤立ファイル・主要関数と`one`一文。**エージェントが作業前に読む1枚**。

---

## Phase 1: extract v2 — シンボル行範囲＋呼び出しグラフ

**Files:** `src/extract.mjs`（拡張）、検証は既存fixtures

- `symbols` に endLine: ブレース/インデント減衰で関数終端推定（完璧主義にしない。取れなければline+30）
- `calls`: JS/TS は `\b(\w+)\s*\(` をシンボル表照合。Python は既存PY_DEF_RE流用
- **受け入れ基準**: foxリポで calls≥10 かつ全callsのf/tが実在ノード&シンボル / synth-2000でextract<3秒 / 既存qa ALL PASS
- コミット: `feat: extract v2 — symbol ranges + intra-repo call graph`

## Phase 2: パネルv2 — atlas文法の詳細パネル

**Files:** `src/render3d.mjs`（showPanel書き換え＋CSS）

- 構成: 種別色チップ + ファイル名 → `one`一文（JSDoc/docstring 1行目から自動抽出。なければ種別テンプレ）→ `Read more`(what相当: exports/imports/LOC折りたたみ) → **Symbols**: 関数リスト（クリックで選択）
- ビルクリック→パネル、関数クリック→関数モード（Phase 3のウォーク起点）
- Esc/空クリックで閉じる（実装済み挙動を維持）
- **受け入れ基準**: 数値QA（パネル高さ<header余白、関数リスト件数=symbols数）+ スクショ提示
- コミット: `feat: atlas-style detail panel with function list`

## Phase 3: ステップウォーク＋常時パケット

**Files:** `src/render3d.mjs`（パケット系を追加。liveEdgesのcurve参照を再利用）

- **ウォーク**: 関数選択→`calls`から呼び出し連鎖をDFS（深さ≤5、訪問済み抑止）→パケットが順番に弧上を `curve.getPoint(t)` で移動。着地ごとに相手ビルが軽く明滅
- **常時パケット**: fan-in上位N本のワイヤを常時ゆっくり流す（向き=呼び出し方向）。量は少なく静かに。`prefers-reduced-motion`尊重
- QAフック: `__walk()` = `{route:[...], t:0..1}`, `__packets()` = 流動中数
- **受け入れ基準**: ウォーク経路がcallsデータと一致 / 26フレーム走査errors none / 既存qa ALL PASS
- コミット: `feat: call-graph step walk + ambient packets`

## Phase 4: CITY.md ＋ insights（意味の層）

**Files:** 新規 `src/citymd.mjs`、`src/insights.mjs`（バッチランナー）

- 先に**LLMなし版**: city.json統計だけでCITY.md生成（区画・hot・孤立）。これで十分使える
- 後に**LLM版**: 上位50シンボル（fanIn×LOC順）の one/what を `claude -p` バッチで生成→insights.json。パネルとCITY.mdが読み込む。失敗時はJSDocフォールバックで常に動く
- **受け入れ基準**: CITY.mdがfoxで<150行で要点を掴める / insights欠落でもパネルが壊れない
- コミット: 分割（`feat: CITY.md generator` / `feat: insights batch via claude -p`）

---

## やらないこと（今回の線引）

- atlasの章立て（progressive disclosure）— 自リポ探索には過剰
- 質問ID追跡 — 設計議論の道具なので範囲外
- SVG移行・外部依存の導入
- メソッド内private呼び出しの完全追跡（クラスメソッドはpublic呼び出しのみ）

## 実行の財布配分

P1〜P3: ox-alphaが直接実装（対話しながら回す）。P4のLLMバッチ部分のみClaude Code委譲（オフライン一括）。

## オープン質問（デフォルト込み）

1. 呼び出しグラフの粒度 → **推奨: 関数→関数＋クラスpublicメソッドまで**（privateはノイズ）
2. Python対応 → **推奨: P1で最小限入れる**（既存PY解析があるので追加コスト小）
3. insights LLMバッチ → **推奨: 構造完成後（P4後半）**。JSDocフォールバックで先に全体が動く

## 検証運用（既存規約継続）

- vision_analyze不使用。ピクセル/幾何はNode側数値検証、スクショはユーザーへMEDIA添付
- 各フェーズ末に qa.mjs ALL PASS ＋ 26フレーム走査 errors none
- フェーズごとにコミット（機能追加とリファクタ混ぜない）
