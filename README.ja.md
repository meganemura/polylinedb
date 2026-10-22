# polylinedb

[English](README.md)

polylinedb (polyline database) は、ローカルのツールとクラウドのエージェントのための個人用 issue ストアである。
コマンドは `pd`、スコープなしの npm パッケージ名は `polylinedb` である。
CLI は、作業中のリポジトリの外にある SQLite ファイル 1 つか、認証済みのクラウド接続のどちらかを選ぶ。
Cloudflare Worker は、D1 をデータベースにして、同じ操作を HTTP とリモート MCP で提供する。
この 2 つは独立したストアであり、polylinedb は両者を同期しない。

## ローカルで始める

Node.js は 24.x 系の 24.20 以降か 26.7 以降を使い、同梱の SQLite が 3.53.4 以降であること。
CLI は Bun、Deno、および古いシステムの SQLite にリンクした Node ビルドを `unsupported_runtime` で拒否する。
Git をインストールし、PATH に置いておく。
CLI はリポジトリの既定値を安全に解決するために Git を使う。
CLI は npm からインストールする。

```sh
npm install --global polylinedb
```

バージョンマネージャーは、リポジトリが別のランタイムを選ぶと Node を切り替えることがある。
`pd` を対応する Node のバージョンに固定するには、`PATH` の前のほうにラッパーを置く。

```sh
#!/bin/sh
exec /opt/example/node-24.22.1/bin/node \
  /opt/example/npm-global/lib/node_modules/polylinedb/dist/cli.js "$@"
```

例の 2 つのパスは、固定する Node のバイナリと、インストールしたパッケージの入口に置き換える。
パッケージは、その Node のグローバル npm ルートの下にインストールしておく必要がある。
`pd --version` を実行すると、インストールされたパッケージのバージョンと、それを起動した Node ランタイムを確かめられる。

作業中のプロジェクトで次のコマンドを実行する。

```sh
pd init --tool compiler --project parser --actor local:owner
pd --actor local:owner create --tool compiler --project parser --body 'Handle empty input'
pd list
pd --help
pd --version
```

Git の中では、初期化は既定値を Git のメタデータに保存し、データルートの `stores` ディレクトリの下に外部ストアを作る。
データルートは、`XDG_DATA_HOME` が絶対パスなら `$XDG_DATA_HOME/polylinedb`、そうでなければ `~/.local/share/polylinedb` である。
Git の外では、`pd init` はリポジトリの既定値なしでそのデータルートを初期化する。
別のディレクトリを選ぶには `--data-dir /absolute/external/directory` か `POLYLINEDB_DATA_DIR` を使う。
そのディレクトリは、現在の作業ディレクトリと、それを囲む Git リポジトリの外になければならない。
既存のデータディレクトリのモードは `0700`、そのデータベースのモードは `0600` でなければならない。
SQLite は書き込み中に一時的なジャーナルを作ることがあるが、永続するストアは `polylinedb.sqlite` である。

コマンドは既定で JSON を返す。
`show`、`list`、`search` の読み取りが成功したときは `--human` を使える。
標準出力をパイプに渡すと、人向けの出力は装飾なしのままになる。
TTY では、`NO_COLOR` がなく `TERM` が `dumb` でないときだけ、決まった見出しに色が付く。
`--human` は `--json` と同時に使えない。
`--` より前に置く。
変更操作のたびに `POLYLINEDB_ACTOR` を設定するか `--actor` を渡す。
actor はローカルの記録で呼び出し元を示す。
ローカルのアクセスを制御するのはファイルシステムの権限である。

## issue を編集する

書き込む前に issue を読み、返ってきたフィールドのバージョンを使う。

```sh
pd show ISSUE_ID
pd --actor local:owner update ISSUE_ID --status deferred --expect status=1
pd --actor local:owner comment ISSUE_ID --body 'Reproduced with empty input'
pd --actor local:owner close ISSUE_ID --expected 2
pd --actor local:owner reopen ISSUE_ID --expected 3
```

例のバージョンは、issue がバージョン 1 から始まり、前のコマンドがそれぞれ成功したことを前提にしている。
競合した更新は全体が失敗する。
読み直して、提案した編集がまだ当てはまるかを判断する。
polylinedb は新しいバージョンで自動的に再試行しない。

バージョン 0.3.0 は、通常の 7 つの issue フィールドを変えずに、スキーマ 6 で所有権のクレームを加える。
バージョン 0.2.0 はスキーマ 5 を使い、クレームのコマンドはない。
CLI とストアが合っていれば、観測した incarnation と呼び出し元のセッションで所有権を調整する。

```sh
pd show ISSUE_ID
pd --actor local:owner claim acquire ISSUE_ID --incarnation OBSERVED_HEX \
  --session-id SESSION_UUID --request-id REQUEST_UUID --agent-label Codex
pd --actor local:owner update ISSUE_ID --status in_progress --expect status=STATUS_VERSION --claim-proof "$PROOF_JSON"
pd --actor local:owner claim renew --claim-proof "$PROOF_JSON" --expected-revision CLAIM_REVISION --request-id RENEW_REQUEST_UUID
pd --actor local:owner claim release --claim-proof "$PROOF_JSON" --expected-revision CLAIM_REVISION --request-id RELEASE_REQUEST_UUID
```

プレースホルダーは、観測した値と、保持しておいた小文字の UUID に置き換える。
`OBSERVED_HEX` は `pd show` の `claim.store_incarnation` である。
`PROOF_JSON` は、受領記録の `issue_id`、`incarnation`、`session_id`、`generation` を含む。
`pd --claim-proof` は `claim_receipt` 全体も受け付け、その 4 つのフィールドを読む。
新しい変更操作の前には、毎回フィールドとクレームのリビジョンを読む。
クレームのライフサイクルが始まった後は、status の書き込みに現在の証明が要る。
force が無視するのは前提条件だけである。
`in_progress` にするには、epic でない限り、常に現在の証明が要る。
期限、確認、引き継ぎ、再試行の規則は [ownership coordination](docs/claims.md) を参照する。
ローカルのエージェントごとに actor を分けるには [local agent actors](docs/agent-actors.md) を参照する。

スキーマ 7 は、ストア全体の変更フィードを加える。
`pd changes --since 0` は issue の変更をコミット順に並べる。
続きは、返ってきた `next_since` と `incarnation` で読む。
`pd wait --since SEQ --timeout SECONDS` は、そのカーソルより後に条件に合うイベントがあると返る。
タイムアウトしたときは、イベントなしで現在のカーソルを返す。
イベントは issue、変更の種類、actor を示す。
そのため、エージェントはすべての issue を読み直さずに、他のエージェントの作業を追える。
[change feed](docs/operations.md#change-feed) を参照する。

`--type epic` で epic を作り、`--parent EPIC_ID` で子を作る。
ルートの ID は `pd-1` のような形で、最初の子は `pd-1.1` になる。
番号は桁数を固定せず、99 の次は 100 になる。
番号の名前空間を選ぶには `--prefix NAME` を使う。
CLI は、既定の接頭辞なら `pd show 1` を `pd show pd-1` の省略形として受け付ける。
epic を閉じても子は閉じない。

Git の中での初期化は、既定で stealth の動作になる。
`--stealth` も引き続き受け付ける。
外部ストアの場所と既定値は Git のメタデータにあり、リンクされた worktree の間で共有される。
ストアを明示的に選ぶには名前付きの接続を使う。
[connection selection](docs/connections.md) を参照する。

create は、再試行をまたいで要求を識別するために `--request-id UUID` を受け付ける。
結果が不確かなときは、同じ引数と actor でその UUID を再び使う。
コマンドは、新しい番号を割り当てずに既存の issue を返す。
省略すると、CLI はその呼び出しのために新しい要求 UUID を作る。

```sh
pd list --status deferred --label maintenance
pd list --human --status deferred --label maintenance
pd search 'empty input' --project parser
pd search -- -Werror
pd show ISSUE_ID --human
pd --actor local:owner update ISSUE_ID --body-file ./description.md --expect body=1
```

search は、本文とコメントの中の文字列を、そのままの形で大文字と小文字を区別して探す。
`--body-file -` は標準入力を読む。
フィールド、既定値、ページ送り、エラーは [operation contract](docs/operations.md) を参照する。

## エージェントのスキルを使う

パッケージには、MCP で作業を選び、クレームし、完了させるエージェントのための [polylinedb スキル](skills/polylinedb/SKILL.md) が入っている。
完了したコミットを共有の `queue` ブランチに積む [polylinedb-queue スキル](skills/polylinedb-queue/SKILL.md) も入っている。
`queue` を main に載せるのはオーナーである。
エージェントは main に push しない。
`skills/polylinedb` と `skills/polylinedb-queue` のディレクトリを丸ごと、ホストのスキルディレクトリにコピーするかシンボリックリンクを張る。
利用側のリポジトリはこれらのスキルを持たないので、エージェントのホストごとにインストールする。
よく使うユーザーディレクトリは `~/.codex/skills`、`~/.claude/skills`、`~/.cursor/skills` である。
ホストごとにインストール元を 1 つ選び、そのホストが求めるとおりにスキルの検出をやり直す。
`pd` をエージェントの PATH に置いておく。
スキルは `pd context` から始め、`pd memory context --project PROJECT` でプロジェクトのメモリを取り出す。
コンテキストを回復した後はメモリの取り出しをやり直し、共有ストアでは明示的なプロジェクトの絞り込みを使う。
スキルの検出はライフサイクルのフックをインストールしない。
ユーザースコープのアダプターには `pd agent install HOST` を使う。
ライフサイクルのアダプターとリビジョンの観測は、バージョン 0.2.0 から使える。
取り出し方とホストの対応は [project memory](docs/memory.md) と [host lifecycle hooks](docs/host-hooks.md) を参照する。
依存のリビジョン、安全な再試行、ready と blocked の作業リストは [issue prerequisites](docs/prerequisites.md) を参照する。
スキルは通常の issue 作業の中でデータベースを初期化しない。

## クラウドのエージェントを使う

npm パッケージは、CLI、ドキュメント、エージェントのスキルを配布する。
Worker のデプロイには、ソースリポジトリへのアクセスと、別途の Cloudflare の設定が要る。
Worker は、Managed OAuth を使う Cloudflare Access の後ろにデプロイする。
エージェントのホストは、そのホストの保護されたコネクターの保存場所を通して `/mcp` エンドポイントに接続する。
認証情報は、プロンプト、ツールの引数、エージェントが読めるサンドボックスの外に置かなければならない。
Worker は検証済みの Access のアサーションを受け付け、明示的な actor の許可リストを使う。

[cloud setup and acceptance checks](docs/cloud.md) を参照する。
ローカルのテストは、特定のクラウドホストがタスクをまたいで OAuth の許可を保ち、更新することまでは確かめない。

ローカルの CLI で認証するには、名前付きのクラウド接続を選び、`pd --connection NAME auth login` を実行する。
認証情報は macOS のキーチェーンか Linux の Secret Service を使い、平文に戻ることはない。
プラットフォームの前提条件、ループバックの登録、復旧は [CLI authentication](docs/cli-authentication.md) を参照する。

```sh
pd connection add cloud --url https://issues.example.com
pd --connection cloud auth login
pd --connection cloud actor
pd --connection cloud create --tool editor --project sample --body 'Check cloud operations'
pd --connection cloud list --project sample
```

CLI を設定するときは、`/mcp` を付けない保護されたオリジンを使う。
issue のコマンドは、どちらの種類の接続でも同じフィールドと期待バージョンを使う。
クラウドのコマンドは actor を認証から導き、`--actor` を拒否する。
応答が不確かでも変更操作を再試行せず、ローカルのストレージにも切り替えない。
import と export はローカルのコマンドのままである。
クラウドへの移行には [D1 migration guide](docs/d1-migration.md) を使う。
既存のクラウドストアを残したまま、共有するリポジトリの既定値を変えるには [local-to-cloud cutover guide](docs/local-cloud-cutover.md) を使う。

## ローカルとクラウドのエージェントの間で作業を引き継ぐ

ローカルの調査役は、確かめた事実をプロジェクトのメモリに保存し、残りの作業を issue に記録できる。
クラウドのエージェントは、MCP で両方の記録を取り出し、受け入れ条件を加え、実装の引き継ぎをコメントに残せる。
新しいローカルのセッションは、クラウドにつないだ CLI でその記録を読み、作業を続けられる。
どのセッションも同じプロジェクトを選び、変更の前に現在のバージョンを読む。
ソースの変更は Git が別に運ぶ。
共有ストアは、事実、タスクの状態、議論を運ぶ。

合成の実験では、小さなラベル整形器を使って、元の会話なしで回復できるかを確かめた。
Cursor Cloud は、既存の認証済み MCP 接続を通して issue とプロジェクトのメモリ全体を取り出した。
追加の認証もソースの変更もなく、受け入れ条件と計画をコメントに保存した。
新しいローカルのエージェントが受け取ったのは、ストア、プロジェクト、issue の識別子だけだった。
そのエージェントは契約と受け入れ条件を読み、整形器を実装し、11 個のテストをすべて通した。
その後、結果を同じ issue に記録し、独立した読み取りでそのコメントを確かめた。
クラウドの運用者はホストと操作を確かめ、別のローカルのレビューが 11 個のテストを再実行した。
この実験は、共有のクラウドストアを通して両方向の引き継ぎを確かめている。

## 開発する

次のコマンドには、インストールした npm パッケージではなく、ソースのチェックアウトが要る。
開発時の依存は、パッケージのマニフェストとロックファイルで固定している。

```sh
npm ci --ignore-scripts
npm run typecheck
npm run check:architecture
npm test
npm run test:package
npm run test:d1
npm run test:worker
```

D1 のテストと Worker のビルドには、ループバックのインターフェースで待ち受ける権限が要る。
`test:worker` は実際のバンドルを workerd でビルドしてテストする。
D1 と、署名したテスト用のアサーションを使う。
ビルドはインストール済みの `cf` CLI を使い、`.cloudflare/output/v0/` を作る。
Worker はデプロイしない。
Vite のプラグインは、実験的な設定のインターフェースを通して `cloudflare.config.ts` に対応している。
`undici` の override は、Cloudflare の開発ツールのためにセキュリティ修正済みのバージョンを選ぶ。
選んだ記録は [dependencies](docs/dependencies.md) を参照する。
読み取りのクエリは、SQLite と D1 の上で solarsql を使う。
[SQL adoption decision](docs/adr/0002-solarsql-reads.md) を参照する。
スキーマかクエリを編集したら、`npm run generate:sql` を実行し、生成されたファイルをコミットする。

[architecture](docs/architecture.md) と [field version decision](docs/adr/0001-field-versions.md) を読む。
シードを固定した性質テスト、範囲を絞ったミューテーションテスト、それらが測った範囲は [verification](docs/verification.md) を参照する。

## ライセンス

MIT。
[LICENSE](LICENSE) を参照する。
