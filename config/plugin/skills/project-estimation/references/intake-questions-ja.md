# Intake questions (asked to the salesperson directly)

Ask only what the doc doesn't answer and can't be safely assumed. Limits are in SKILL.md Calibration. One line per question, no explanations of why. Allow 「わからない」.

## Text format (when no question tool is available - this is the whole reply)

```
見積もりの前に、<N>点だけ教えてください（わからなければ「わからない」でOKです）。

1. <question>（<option>／<option>／わからない）
2. <question>（<option>／<option>／わからない）

前提にしたこと（違っていたら教えてください）：
- <要件書より／仮定>：<one-line assumption>
- <要件書より／仮定>：<one-line assumption>
```

Example assumption lines:
- 要件書より：今使っているツール（月1.5万円）の置き換え
- 仮定：1物件は30〜150戸くらい
- 仮定：社内の人だけが使うので、新しいドメインを使う（会社のホームページやメールには手を入れない）

## Question tool format

Same Japanese questions and options, one question each - no extra questions. Before the questions, in text:

```
見積もりの前に、<N>点だけ教えてください。

前提にしたこと（違っていたら、そのまま返信で教えてください）：
- <要件書より／仮定>：<one-line assumption>
```

If an answer needs details (e.g. ある), ask a short follow-up in text.

## Question bank (pick, don't add)

| # | Question (copy as-is) | Options | Ask when |
|---|---|---|---|
| 1 | 新しく作るシステムですか？今使っているものの置き換えですか？ | 新しく作る／置き換え／今のシステムに追加／わからない | The doc doesn't say. If it does, list it as an assumption instead |
| 1b | 今のデータ（進行中の予約や登録済みの情報など）を新しいシステムに移しますか？ | 移す／移さない／わからない | Replacement or addition, and the doc doesn't cover migration |
| 2 | 画面やメールは、会社のホームページと同じドメイン（例：@会社名.co.jp）を使いますか？ | 会社のドメインを使う／新しいドメインでOK／わからない | Ask unless the doc already answers it, or only the client's own staff will use the system (then assume a new domain, 仮定). If 会社のドメインを使う: ask for the domain and server company (Xserver、さくら など), and 「そのドメインで、メールやブログなど他のサービスも使っていますか？」（ある／ない／わからない） - this decides the platform |
| 3 | 他のシステムとつなぐ必要はありますか？（会計ソフト、LINE、カード決済 など） | ある／ない／わからない | The doc doesn't say "no integrations". If ある: ask which |
| 4 | 納品後のサーバー代などの月額費用は、誰が払いますか？ | クライアント／うち／わからない | Almost always. Name the usage-billed items if any (e.g. 「サーバー代やSMS代などの月額費用」) |
| 4b | 納品後の保守（修正・問い合わせ対応）の契約はありますか？ | ある／ない／わからない | Almost always |
| 5 | 必ず守る条件はありますか？（使い始める日、データは国内に置く、管理会社のルール など） | ある／ない／わからない | The doc doesn't cover deadline and data/security rules. Quote the doc line that raised it, if any. If ある: ask which |
| 6 | だいたいの件数を教えてください。（例：月に何件予約が入るか） | 少ない（〜100件）／中くらい（〜1,000件）／多い（1,000件〜）／わからない | Only if no range can be assumed |

Adapt the examples in parentheses to the project (e.g. 予約 → 注文), but keep the wording plain.
