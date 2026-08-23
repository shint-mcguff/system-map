# System Map — スパイク結果

2026-08-22。コードベースをアイソメ3D都市として可視化し、編集しながら眺められるかの技術検証。

## 構成

```
src/extract.mjs      コードベース歩行 → importグラフ抽出（tsconfig paths対応）
src/render.mjs       city.json → SVGアイソメ都市の自己完結HTML
src/serve.mjs        watch + SSEホットリロードサーバー
src/gen-fixture.mjs  スケール検証用フィクスチャ生成器
dist/fox.html        fox（Next.js実リポジトリ）の静的マップ
http://localhost:7788  foxのライブマップ（保存で自動更新）
```

ゼロ依存（node builtinsのみ）。描画はthree.js不使用、素のSVG多角形。

## 計測

| 項目 | 結果 | 判定 |
|---|---|---|
| 抽出 2000ファイル・2269エッジ | **135ms** | ✅ 全量再パースでも余裕 |
| 保存→再構築→HTML書き出し（17ファイル） | **11-15ms** | ✅ 要件(<100ms)クリア |
| レンダリング 2000ノートSVG | 25ms / 1.2MB HTML | ✅ |
| エイリアス解決（`@/*`） | tsconfig読みで対応 | ✅ |

## Verdict: VALIDATED

「編集しながらアイソメ地図を見る」は、ゼロ依存の単純な構成で実用速度が出る。
ボトルネックはどこでもなく、次の投資先はUX（レイアウト美しさ・ドリルダウン）。

## 次の一手候補

1. 区画レイアウト改善（treemap化・高さ=LOC色=fanInなど表現の洗練）
2. シンボルレベル drill-down（nagmotiスキルのstruct相当、tree-sitterで）
3. VS Code webview 化（エディタと同一画面に）
4. エージェント観戦モード（Claude Codeログを発光再生、mindwalk互換）
