# system-map VS Code拡張

エディタの横に街を並べて、**ビル⇄ファイルを双方向に繋ぐ**拡張。
生成物が単一自己完結HTMLなので、webviewにそのまま載せている。

## 動かす

```bash
npm i                                        # ルートで（three が要る）
code --extensionDevelopmentPath="<repo>/vscode" <対象リポジトリ>
```

または `vscode/` をVS Codeで開いて **F5**（Extension Development Host が立つ）。

コマンドパレットから **`System Map: 街を開く`**。

## できること

| | |
|---|---|
| ビルをクリック | 対応するファイルがエディタで開く（フォーカスは奪わない） |
| エディタを切り替え | 対応するビルが自動で選択・ハイライトされる |
| ファイルを保存 | そのファイルだけ再解析して街が更新される（視点と選択は維持） |
| `System Map: このファイルのビルへ` | 今開いているファイルのビルを選択する |

設定（`systemMap.*`）で保存連動・エディタ追従・クリックで開く をそれぞれ切れる。

## 構成

```
extension.js   コマンド登録・webview・双方向メッセージ・保存フック
worker.mjs     解析と描画を担当する子プロセス（拡張ホストをブロックしないため）
test-bridge.mjs  VS Code無しでworkerとブリッジを検証する（headless Chrome）
```

解析は `createSession()` を子プロセスに常駐させ、保存されたファイルだけ
`session.update()` で再解析する。`cp.fork` は `ELECTRON_RUN_AS_NODE=1` を渡して
VS Code本体（Electron）を素のNodeとして起動している。

webviewに載せる前に CSP を差し込む。three.js が Blob URL を作って動的importするため
`script-src` と `connect-src` に `blob:` を許可している（外部通信は一切しない）。

ページ側のフック（`__select` / `__cam` / `__setCam` / `__onSelect`）でホストと繋ぐ。
`__onSelect` はユーザ操作の選択だけを通知するので、ホスト起点の選択がループしない。

## 検証

```bash
node vscode/test-bridge.mjs <対象リポジトリ>
```

worker のIPC（init/update/render）→ CSP+ブリッジ注入 → headless Chromeで
起動時の視点・選択復元 / ホスト→選択 / クリック→ホスト通知 / 視点要求 を通しで確認する。

## 既知の制限

- **保存のたびHTMLを作り直して webview に入れ直している。** 視点と選択は復元するが、
  3Dシーンは組み直しになる（JIKON 168ファイルで再描画40ms＋ページ再初期化）。
  レイアウト計算はNode側なので、`render3d` からレイアウトを切り出して
  ページ側に `__applyScene(data)` を生やせば、シーンを保ったまま差分更新できる。ここが次の一手。
- ワークスペースの最初のフォルダのみ対象（マルチルート未対応）。
- `tsconfig.json` の `paths` を変えたときは街を開き直す必要がある。
