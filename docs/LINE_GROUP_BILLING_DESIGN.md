# LINEグループ単位 課金モデル 設計書

## 概要

- **課金単位**: LINE のグループ（`groupId`）。個人（`userId`）や招待コードは使わない。
- **利用形態**: スタッフの LINE グループにレオンくんを招待し、グループ内で利用。
- **課金**: グループの代表者（女将さんなど）が Stripe で月額サブスクを契約すると、その **groupId が Premium** になり、**グループ内メンバー全員が AI 機能を使い放題**になる。基本は**即時課金（初月無料なし）**。特定の営業先には Stripe の**プロモーションコード（クーポン）**で初月無料や割引を提供する。Checkout 作成時は **`allow_promotion_codes: true`** を必ず含める。

---

## 1. Supabase データベース設計

### 1.1 テーブル一覧

| テーブル名 | 役割 |
|-----------|------|
| `line_groups` | グループ単位の契約・Stripe 紐付け |
| `stripe_webhook_events` | 冪等性のための Webhook イベント記録（任意） |

---

### 1.2 `line_groups` テーブル

グループごとに 1 行。LINE の `groupId` をキーに、契約状態と Stripe 情報を保持する。

| カラム名 | 型 | 制約 | 説明 |
|----------|-----|------|------|
| `id` | `uuid` | PK, default `gen_random_uuid()` | 内部 ID |
| `line_group_id` | `text` | NOT NULL, UNIQUE | LINE のグループ ID（`event.source.groupId`） |
| `display_name` | `text` | | グループ名（LINE から取得、任意） |
| `plan` | `text` | NOT NULL, default `'free'` | `'free'` \| `'trial'` \| `'premium'` \| `'canceled'` \| `'past_due'` |
| `stripe_customer_id` | `text` | | Stripe 顧客 ID（請求先の代表者） |
| `stripe_subscription_id` | `text` | | Stripe サブスクリプション ID |
| `trial_ends_at` | `timestamptz` | | 無料トライアル終了日時 |
| `current_period_end` | `timestamptz` | | 現在の課金期間の終了日時 |
| `created_at` | `timestamptz` | NOT NULL, default `now()` | レコード作成日時 |
| `updated_at` | `timestamptz` | NOT NULL, default `now()` | 最終更新日時 |

**インデックス**

- `line_group_id` に UNIQUE 制約（検索は `WHERE line_group_id = $1` で行うため、UNIQUE で十分な場合が多い。必要なら `CREATE UNIQUE INDEX idx_line_groups_line_group_id ON line_groups(line_group_id);`）

**補足**

- `plan = 'free'`: 未契約。AI 利用不可（課金案内のみ）。
- `plan = 'trial'`: トライアル中。`trial_ends_at` が未来なら利用可。
- `plan = 'premium'`: 有料契約中。`current_period_end` が未来なら利用可。
- `plan = 'canceled'`: 解約済み。`current_period_end` まで利用可。
- `plan = 'past_due'`: 支払い遅延。運用方針に応じて利用可／不可を決める。

---

### 1.3 `stripe_webhook_events` テーブル（推奨）

Stripe Webhook の冪等性確保とデバッグ用。

| カラム名 | 型 | 制約 | 説明 |
|----------|-----|------|------|
| `id` | `uuid` | PK, default `gen_random_uuid()` | 内部 ID |
| `stripe_event_id` | `text` | NOT NULL, UNIQUE | Stripe の `event.id` |
| `type` | `text` | NOT NULL | 例: `customer.subscription.created` |
| `payload` | `jsonb` | | 必要なら保存（デバッグ用） |
| `processed_at` | `timestamptz` | | 処理完了日時 |
| `created_at` | `timestamptz` | NOT NULL, default `now()` | 受信日時 |

同一 `stripe_event_id` が再来した場合は「既に処理済み」としてスキップする。

---

### 1.4 Supabase 用 SQL（実行例）

```sql
-- line_groups
CREATE TABLE line_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_group_id text NOT NULL UNIQUE,
  display_name text,
  plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'trial', 'premium', 'canceled', 'past_due')),
  stripe_customer_id text,
  stripe_subscription_id text,
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_line_groups_line_group_id ON line_groups(line_group_id);
CREATE INDEX idx_line_groups_plan ON line_groups(plan);

-- updated_at 自動更新（任意）
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER line_groups_updated_at
  BEFORE UPDATE ON line_groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- stripe_webhook_events（冪等用）
CREATE TABLE stripe_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id text NOT NULL UNIQUE,
  type text NOT NULL,
  payload jsonb,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_stripe_webhook_events_stripe_event_id ON stripe_webhook_events(stripe_event_id);
```

---

## 2. 処理フロー：課金URLを受け取ってから「使い放題」になるまで

前提:

- スタッフの LINE グループにレオンくんが招待されている。
- メッセージは「グループチャット」から送られる（`event.source.type === 'group'` かつ `event.source.groupId` が存在）。

---

### フロー全体像（簡略）

```
[グループでボット利用] → グループがPremium？ 
  → No: 課金案内 or 「課金する」で Checkout URL 返却
  → 代表者が Stripe で支払い（トライアル含む）
  → Stripe Webhook で DB 更新 → groupId を Premium に
  → 以降、同じグループ内は使い放題
```

---

### ステップ 1: グループでメッセージを受信

1. ユーザーが **グループ**で「【モード切替：メール】」や「【モード切替：クチコミ】」などを送信。
2. Webhook で受信したイベントに `event.source.type === 'group'` かつ `event.source.groupId` があることを確認。
3. **個人チャット**（`event.source.type === 'user'`）の場合は、  
   「レオンくんはスタッフのLINEグループに招待してご利用ください」などと返し、グループ課金フローには進まない。

---

### ステップ 2: グループの契約状態を取得

1. `event.source.groupId` をキーに Supabase の `line_groups` を検索。
2. レコードが **ない** → 初回利用とみなし、`plan = 'free'` と同じ扱い（課金案内へ）。
3. レコードが **ある** → `plan` と `trial_ends_at` / `current_period_end` から「いま利用可能か」を判定。

**利用可能条件の例（ロジック）**

- `plan = 'trial'` かつ `trial_ends_at > now()` → 利用可。
- `plan = 'premium'` かつ `current_period_end > now()` → 利用可。
- `plan = 'canceled'` かつ `current_period_end > now()` → 利用可（解約済みだが期間終了まで）。
- 上記以外 → 利用不可 → 課金案内 or 再契約案内。

---

### ステップ 3: 未契約・契約切れの場合の案内

1. 利用不可と判定したら、グループに返信する内容を決める。
2. 案内文の例:  
   「このグループでAI機能をご利用いただくには、月額課金が必要です。割引クーポンをお持ちの方は支払い画面でご利用いただけます。代表者の方は「**課金する**」と送ってください。」
3. ユーザーが「課金する」など特定キーワードを送ったら **ステップ 4** へ。  
   それ以外のメール/クチコミ系の文言の場合は「まずは課金してください」と案内に留める。

---

### ステップ 4: Stripe Checkout URL の発行

1. 「課金する」と送ったメッセージの `event.source.groupId` を取得。
2. バックエンドで **Stripe Checkout Session** を作成。
   - **必ず `allow_promotion_codes: true`** を指定し、Stripe のプロモーションコード（クーポン）が利用可能にする。特定の営業先には初月無料・割引用のクーポンを発行して案内する。
   - **subscription_data.metadata** に `line_group_id: groupId` を必ず含める（Webhook でどのグループを Premium にするか識別するため）。
   - 基本は即時課金（初月無料なし）の Price ID を指定。トライアル・割引はクーポンで対応。
   - `success_url` / `cancel_url` は、自社の説明ページや Thank you ページへ。
3. 作成した `session.url` を LINE でグループに返信。  
   例: 「お支払いページはこちらです。代表者の方が完了してください：[Checkout URL]」
4. （任意）`line_groups` に `line_group_id` のみの行を事前に INSERT（`plan = 'free'`）しておくと、後続の Webhook では UPDATE だけで済む。

---

### ステップ 5: 代表者が Stripe で支払い

1. 代表者が Checkout リンクを開き、Stripe の画面で支払い情報を入力。プロモーションコードをお持ちの場合は入力して割引・初月無料を適用。
2. クーポンでトライアルが付与されている場合は「トライアル開始」としてサブスクが作成され、請求はトライアル終了後から。
3. 支払いまたはトライアル開始が完了すると、Stripe が **Webhook** でサーバーにイベントを送る。

---

### ステップ 6: Stripe Webhook で DB 更新（グループを Premium に）

1. **受け取るイベント例**
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.paid` / `invoice.payment_failed` など（必要に応じて）
2. **冪等処理**
   - `stripe_webhook_events` に `event.id` を INSERT。  
     UNIQUE 違反（既に存在）なら「処理済み」として何もしない。
3. **対象グループの特定**
   - Checkout Session 作成時に metadata に保存した `line_group_id` を取得。  
     - `customer.subscription.created` の場合: `event.data.object` の `metadata.line_group_id` または、Session を取得して metadata を参照。  
     - Stripe では Subscription の metadata に Checkout 時の metadata を引き継がせられるようにするか、**Checkout Session 作成時に `subscription_data.metadata` に `line_group_id` を設定**しておく。
4. **line_groups の更新**
   - `line_group_id` で行を検索（なければ INSERT）。
   - 設定する値の例:
     - `stripe_customer_id`: `subscription.customer`
     - `stripe_subscription_id`: `subscription.id`
     - `trial_ends_at`: `subscription.trial_end` を日時に変換
     - `current_period_end`: `subscription.current_period_end` を日時に変換
     - `plan`: トライアル中なら `'trial'`、通常なら `'premium'`、解約済みなら `'canceled'`、支払い失敗なら `'past_due'` など。
5. `stripe_webhook_events` の `processed_at` を更新（処理完了時刻を記録）。

---

### ステップ 7: 以降のメッセージで「使い放題」として扱う

1. 同じグループから再度「【モード切替：メール】」などが送られる。
2. **ステップ 2** の判定で、`line_groups` の `plan` と期間から「利用可」と判定。
3. 既存のレオンくんの処理（メール返信・クチコミ返信の状態遷移と OpenAI 呼び出し）をそのまま実行。
4. グループ内の **どのメンバー**が送っても、**groupId が Premium なら全員使い放題**とする（個人単位の枠は設けない）。

---

## 3. フロー図（シーケンス）

```
[グループメンバー]     [レオンくん Bot]     [Supabase]     [Stripe]
       |                      |                   |              |
       | 【モード切替：メール】 |                   |              |
       |--------------------->|                   |              |
       |                      | line_group_id で   |              |
       |                      | 契約状態取得       |--------------|
       |                      |<------------------|              |
       |                      | (free / 未登録)    |              |
       | 課金案内＋「課金する」|                   |              |
       |<---------------------|                   |              |
       |                      |                   |              |
       | 「課金する」         |                   |              |
       |--------------------->| Checkout Session   |              |
       |                      | 作成(metadata     |-------------->
       |                      | line_group_id)    |              |
       | 支払いページURL      |                   |              |
       |<---------------------|                   |              |
       |                      |                   |              |
       | (代表者がブラウザで支払い・トライアル開始)              |
       |                      |                   |     Webhook  |
       |                      |<----------------------------------|
       |                      | 冪等チェック＆     |              |
       |                      | line_groups 更新   |--------------|
       |                      | (Premium/trial)   |              |
       |                      |                   |              |
       | 【モード切替：メール】|                   |              |
       |--------------------->| 契約あり → 利用可  |              |
       |                      | メール返信フロー   |              |
       | 翻訳・要約...        | (OpenAI)          |              |
       |<---------------------|                   |              |
```

---

## 4. 実装時の注意点（まとめ）

- **グループ判定**: 必ず `event.source.type === 'group'` かつ `event.source.groupId` がある場合だけグループ課金ロジックに進める。
- **Checkout の metadata**: `line_group_id` を必ず渡し、Stripe の Subscription に `subscription_data.metadata` で引き継がせると、Webhook でグループを一意に特定しやすい。
- **冪等**: Stripe は同じイベントを再送することがあるため、`stripe_webhook_events` で `event.id` を記録し、重複処理を防ぐ。
- **トライアル・解約**: `trial_ends_at` / `current_period_end` で「いつまで使えるか」を判定し、期限切れの場合は再度課金案内に誘導する。

この設計に沿って実装すれば、**「グループで課金URLを受け取る → 代表者が支払い → そのグループが使い放題になる」**までを一貫して扱えます。
