require('dotenv').config();
const express = require('express');
const dns = require('node:dns').promises;
const { Client, middleware } = require('@line/bot-sdk');
const OpenAI = require('openai').default;
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

// ========== 設定 ==========
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const lineClient = new Client(lineConfig);

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// Supabase: 環境変数は .trim() で前後の空白を除去してから使用（/webhook 内でもこのクライアントを参照）
let supabaseUrl = (process.env.SUPABASE_URL || '').trim();
const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

// .co → .com 自動補正（Supabase の正しいドメインは .com）
if (supabaseUrl && supabaseUrl.endsWith('.co') && !supabaseUrl.endsWith('.com')) {
  const before = supabaseUrl;
  supabaseUrl = supabaseUrl.replace(/\.co$/, '.com');
  console.log('[Supabase] URL を .co → .com に補正しました:', before.substring(0, 20) + '...' + before.slice(-6), '→', supabaseUrl.substring(0, 20) + '...' + supabaseUrl.slice(-8));
}

// 住所の徹底検証：先頭・末尾・文字数をログ（中間は隠す）
if (supabaseUrl) {
  const len = supabaseUrl.length;
  const head = supabaseUrl.substring(0, Math.min(12, len));
  const tail = len > 14 ? supabaseUrl.slice(-10) : supabaseUrl;
  console.log('[Supabase] URL Check:', head + (len > 22 ? '...' + tail : tail), '(計' + len + '文字)');
}

// DNS 解決の事前チェック（fetch 前に名前解決できるかテスト）
async function checkSupabaseDns(url) {
  if (!url) return;
  try {
    const hostname = new URL(url).hostname;
    const result = await dns.lookup(hostname, { all: false });
    console.log('[Supabase] DNS 解決 OK:', hostname, '→', result.address);
  } catch (err) {
    console.error('[Supabase] DNS 解決 FAIL:', err.hostname || new URL(url).hostname, 'code:', err.code, 'message:', err.message);
  }
}
if (supabaseUrl) {
  checkSupabaseDns(supabaseUrl).catch((e) => console.error('[Supabase] DNS check error:', e));
}

// クライアント作成（オプションで安定化）
const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false },
        global: { fetch: (...args) => fetch(...args) },
      })
    : null;

// 起動時に Supabase 環境変数が読み込まれているか確認（Webhook で DB 更新するために必須）
(function logSupabaseEnv() {
  console.log('[Startup] SUPABASE_URL:', supabaseUrl ? `${supabaseUrl.substring(0, 30)}...` : 'undefined');
  console.log('[Startup] SUPABASE_SERVICE_ROLE_KEY:', supabaseKey ? `${supabaseKey.substring(0, 8)}...` : 'undefined');
  console.log('[Startup] supabase client:', supabase ? 'OK' : 'NG (DB更新はスキップされます)');
})();

/** レオンくんの魂（System Prompt）＋ 絶対ルール */
const LEON_SYSTEM_PROMPT = `あなたは単なる翻訳機ではありません。地方の老舗旅館で、毎日夜中までインバウンド対応に疲弊している女将さんを救うために生まれた、最強のデジタル右腕『レオンくん』です。女将さんの時間を1秒でも削ること、そして日本の旅館の温かい人柄と最高のおもてなしの心を外国人客に完璧に伝えることがあなたの最大の使命です。出力する文章には、女将らしい上品さと温かみを込めてください。

【追加する絶対ルール（必ず守ること）】
1. 相手の言語に合わせる: ユーザーから送られてきた元の文章（英語、中国語など）の言語を判別し、返信案は必ず「その言語と同じ言語」で作成すること。外国語で書かれた文章に対して、日本語だけで返信案を作成しないこと。
2. 安心の日本語訳: ユーザー（女将さん）が内容を確認して安心できるよう、作成した外国語の返信案には必ず「日本語訳」をセットで出力すること。また、元の文章の日本語訳を最初に軽く添えると親切である。`;

// ========== 状態管理（ユーザーID → { state, originalEmail? }） ==========
const userState = new Map();

const STATES = {
  DEFAULT: null,
  MAIL_WAIT: 'メール待機',
  MEMO_WAIT: 'メモ待機',
  REVIEW_WAIT: 'クチコミ待機',
};

function getState(userId) {
  const entry = userState.get(userId);
  return entry ? entry.state : STATES.DEFAULT;
}

function setState(userId, state, originalEmail = undefined) {
  if (state === null) {
    userState.delete(userId);
    return;
  }
  userState.set(userId, { state, originalEmail });
}

// ========== グループ課金（Supabase + Stripe） ==========

/** イベントがグループチャット由来か */
function isGroupEvent(event) {
  return event.source?.type === 'group' && event.source?.groupId;
}

/** グループIDを取得（グループでない場合は null） */
function getGroupId(event) {
  return event.source?.type === 'group' ? event.source.groupId : null;
}

function isAdminUser(userId) {
  return !!process.env.ADMIN_USER_ID && userId === process.env.ADMIN_USER_ID;
}

function isTestGroupId(groupId) {
  if (!groupId) return false;
  const raw = process.env.ADMIN_TEST_GROUP_IDS || '';
  const ids = raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return ids.includes(groupId);
}

/** グループが Premium 利用可能か（契約あり・期限内） */
async function isGroupPremium(lineGroupId) {
  if (!supabase) return false; // Supabase 未設定時は課金必須（未契約扱い）
  const { data, error } = await supabase
    .from('line_groups')
    .select('plan, trial_ends_at, current_period_end')
    .eq('line_group_id', lineGroupId)
    .single();
  if (error || !data) return false;
  const now = new Date().toISOString();
  const plan = data.plan;
  if (plan === 'trial' && data.trial_ends_at && data.trial_ends_at > now) return true;
  if ((plan === 'premium' || plan === 'canceled') && data.current_period_end && data.current_period_end > now) return true;
  return false;
}

/** Stripe Checkout Session を作成（プロモーションコード対応）。グループ課金用 API。 */
async function createCheckoutSessionForGroup(lineGroupId) {
  if (!stripe || !process.env.STRIPE_PRICE_ID) {
    throw new Error('Stripe is not configured (STRIPE_SECRET_KEY, STRIPE_PRICE_ID)');
  }
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url: `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${BASE_URL}/cancel`,
    metadata: {
      line_group_id: lineGroupId,
    },
    allow_promotion_codes: true,
    subscription_data: {
      metadata: { line_group_id: lineGroupId },
    },
  });
  return { url: session.url };
}

/** line_groups に未登録なら free で 1 件挿入（Webhook で UPDATE しやすくするため） */
async function ensureGroupRow(lineGroupId) {
  if (!supabase) return;
  await supabase.from('line_groups').upsert(
    { line_group_id: lineGroupId, plan: 'free' },
    { onConflict: 'line_group_id', ignoreDuplicates: true }
  );
}

// ========== OpenAI 呼び出し ==========

/** メール本文を日本語に翻訳し簡潔に要約 */
async function translateAndSummarize(emailText) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: LEON_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `以下のお客様からのメールを日本語に翻訳し、簡潔に要約してください。要約のみを出力してください。\n\n---\n${emailText}`,
      },
    ],
  });
  return completion.choices[0].message.content.trim();
}

/** 相手のメールと回答メモから、相手の言語で丁寧な返信文を作成（日本語訳付き） */
async function createEmailReply(originalEmail, replyMemo) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: LEON_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `【相手から届いたメール（原文）】\n${originalEmail}\n\n【女将さんが書きたい内容のメモ】\n${replyMemo}\n\n上記をもとに、次の形式で出力してください。絶対ルールを守ること。\n\n■ 出力形式（この順で必ず出力）\n1. 「【元のメールの内容（日本語）】」見出しの下に、元メールの要点を日本語で1〜2行で簡潔に。\n2. 「【返信文（相手の言語）】」見出しの下に、相手のメールと同じ言語（英語なら英語、中国語なら中国語など）で丁寧な接客用の返信文を1通。そのままコピーして送れる形で。\n3. 「【日本語訳】」見出しの下に、上記返信文の日本語訳をそのまま記載。`,
      },
    ],
  });
  return completion.choices[0].message.content.trim();
}

/** クチコミに対する温かい返信文を作成（相手の言語＋日本語訳付き） */
async function createReviewReply(reviewText) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: LEON_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `以下のお客様のクチコミに対して、旅館の女将として温かく上品な返信文を書いてください。絶対ルールを守ること。\n\n■ 出力形式（この順で必ず出力）\n1. 「【元のクチコミの内容（日本語）】」見出しの下に、元のクチコミの要点を日本語で1〜2行で簡潔に。\n2. 「【返信文（相手の言語）】」見出しの下に、クチコミと同じ言語（英語なら英語、中国語なら中国語など）で温かい返信文を1通。感謝とまたのお越しを歓迎する気持ちを込め、そのままコピーして送れる形で。\n3. 「【日本語訳】」見出しの下に、上記返信文の日本語訳をそのまま記載。\n\n---\n${reviewText}`,
      },
    ],
  });
  return completion.choices[0].message.content.trim();
}

// ========== イベント処理（状態遷移 + 返信） ==========

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return;
  }

  const userId = event.source.userId;
  const text = event.message.text.trim();
  const replyToken = event.replyToken;

  const isGroup = isGroupEvent(event);
  const groupId = getGroupId(event);
  const isAdmin = isAdminUser(userId);
  const isTestGroup = isTestGroupId(groupId);
  const bypassBilling = isAdmin || isTestGroup;

  // ---------- 個人チャット：開発者以外は案内のみ ----------
  if (!isGroup && !isAdmin) {
    await lineClient.replyMessage(replyToken, {
      type: 'text',
      text: 'レオンくんはスタッフのLINEグループに招待してご利用ください。グループで「メール」や「クチコミ」からお試しください。',
    });
    return;
  }

  // ---------- 迷わせない「課金」導線 ----------
  if (text === '課金') {
    if (!isGroup) {
      await lineClient.replyMessage(replyToken, {
        type: 'text',
        text: '課金のお手続きは、実際にご利用になるスタッフ用のLINEグループから「課金」と送っていただく必要があります。対象のグループでお試しください。',
      });
      return;
    }
    try {
      await ensureGroupRow(groupId);
      const { url } = await createCheckoutSessionForGroup(groupId);
      await lineClient.replyMessage(replyToken, {
        type: 'text',
        text: `こちらからプレミアムプラン（月額制）のお手続きが可能です。割引クーポンをお持ちの方は支払い画面でご入力ください！ 💳\n${url}`,
      });
    } catch (err) {
      console.error('createCheckoutSessionForGroup error:', err);
      await lineClient.replyMessage(replyToken, {
        type: 'text',
        text: '申し訳ございません。一時的なエラーです。少し時間をおいてから、もう一度「課金」と送ってください。',
      });
    }
    return;
  }

  // ---------- 世界一誠実な「解約・管理」 ----------
  if (text === '解約') {
    if (!isGroup) {
      await lineClient.replyMessage(replyToken, {
        type: 'text',
        text: '解約やご利用状況の確認は、実際にご利用中のスタッフ用グループから「解約」と送っていただく必要があります。対象のグループでお試しください。',
      });
      return;
    }
    if (!supabase) {
      await lineClient.replyMessage(replyToken, {
        type: 'text',
        text: '申し訳ございません。一時的なエラーです。少し時間をおいてから、もう一度「解約」と送ってください。',
      });
      return;
    }
    try {
      const { data, error } = await supabase
        .from('line_groups')
        .select('stripe_customer_id')
        .eq('line_group_id', groupId)
        .single();
      if (error) {
        console.error('Supabase stripe_customer_id fetch error:', error);
        await lineClient.replyMessage(replyToken, {
          type: 'text',
          text: '申し訳ございません。一時的なエラーです。少し時間をおいてから、もう一度「解約」と送ってください。',
        });
        return;
      }
      const customerId = data?.stripe_customer_id;
      if (!customerId) {
        await lineClient.replyMessage(replyToken, {
          type: 'text',
          text: '決済データが見つかりません。プレミアムプランのご契約状況に心当たりがない場合は、そのままご安心ください。再度ご利用いただく場合は「課金」と送ってくださいね。',
        });
        return;
      }
      if (!stripe) {
        await lineClient.replyMessage(replyToken, {
          type: 'text',
          text: '申し訳ございません。一時的なエラーです。少し時間をおいてから、もう一度「解約」と送ってください。',
        });
        return;
      }
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${BASE_URL}/subscription/portal-return`,
      });
      await lineClient.replyMessage(replyToken, {
        type: 'text',
        text: `いつでもこちらから解約、カード情報の変更、領収書の確認が可能です。ご利用ありがとうございました！ 🚪\n${portalSession.url}`,
      });
    } catch (err) {
      console.error('billingPortal.sessions.create error:', err);
      await lineClient.replyMessage(replyToken, {
        type: 'text',
        text: '申し訳ございません。一時的なエラーです。少し時間をおいてから、もう一度「解約」と送ってください。',
      });
    }
    return;
  }

  // ---------- 爆速モード切り替え（キーワード） ----------
  if (text === 'メール') {
    setState(userId, STATES.MAIL_WAIT);
    await lineClient.replyMessage(replyToken, {
      type: 'text',
      text: '了解です！これからは「メール返信」をお手伝いします。返したい内容を教えてください！',
    });
    return;
  }

  if (text === 'クチコミ') {
    setState(userId, STATES.REVIEW_WAIT);
    await lineClient.replyMessage(replyToken, {
      type: 'text',
      text: '承知しました！「クチコミ返信」をお手伝いします。お客様のクチコミを貼り付けてください！',
    });
    return;
  }

  // ---------- 課金チェック：管理者・テストグループ以外はDBで確認 ----------
  if (isGroup && !bypassBilling) {
    try {
      const premium = await isGroupPremium(groupId);
      if (!premium) {
        await lineClient.replyMessage(replyToken, {
          type: 'text',
          text: 'このグループでAI機能をご利用いただくには、月額課金が必要です。代表者の方は「課金」と送ってください。',
        });
        return;
      }
    } catch (err) {
      console.error('isGroupPremium error:', err);
      await lineClient.replyMessage(replyToken, {
        type: 'text',
        text: '申し訳ございません。一時的なエラーです。少し時間をおいてから、もう一度お試しください。',
      });
      return;
    }
  }

  const state = getState(userId);

  // ---------- モード切替（従来のトリガーも維持） ----------
  if (text === '【モード切替：メール】') {
    setState(userId, STATES.MAIL_WAIT);
    await lineClient.replyMessage(replyToken, {
      type: 'text',
      text: 'メールのお返事ですね！相手から来たメールの文章をそのまま送ってください。',
    });
    return;
  }

  if (text === '【モード切替：クチコミ】') {
    setState(userId, STATES.REVIEW_WAIT);
    await lineClient.replyMessage(replyToken, {
      type: 'text',
      text: 'クチコミのお返事ですね！お客様が書いてくれたクチコミをそのまま送ってください。',
    });
    return;
  }

  // ---------- メール待機 → メモ待機 ----------
  if (state === STATES.MAIL_WAIT) {
    setState(userId, STATES.MEMO_WAIT, text);
    let summary;
    try {
      summary = await translateAndSummarize(text);
    } catch (err) {
      console.error('OpenAI translateAndSummarize error:', err);
      setState(userId, STATES.MAIL_WAIT);
      await lineClient.replyMessage(replyToken, {
        type: 'text',
        text: '申し訳ございません。処理中にエラーが発生しました。もう一度メールの内容を送ってください。',
      });
      return;
    }
    await lineClient.replyMessage(replyToken, {
      type: 'text',
      text: `内容を翻訳しました：『${summary}』\n\nどのようなお返事をしますか？（例：夕食は20時まで等、短いメモでOKです！）`,
    });
    return;
  }

  // ---------- メモ待機 → 下書き返却・状態リセット ----------
  if (state === STATES.MEMO_WAIT) {
    const entry = userState.get(userId);
    const originalEmail = entry?.originalEmail || '';
    setState(userId, null);
    let draft;
    try {
      draft = await createEmailReply(originalEmail, text);
    } catch (err) {
      console.error('OpenAI createEmailReply error:', err);
      await lineClient.replyMessage(replyToken, {
        type: 'text',
        text: '申し訳ございません。返信文の作成中にエラーが発生しました。もう一度メモを送ってください。',
      });
      return;
    }
    await lineClient.replyMessage(replyToken, {
      type: 'text',
      text: `下書きが完成しました！確認してコピーしてください：\n\n${draft}`,
    });
    return;
  }

  // ---------- クチコミ待機 → 下書き返却・状態リセット ----------
  if (state === STATES.REVIEW_WAIT) {
    setState(userId, null);
    let draft;
    try {
      draft = await createReviewReply(text);
    } catch (err) {
      console.error('OpenAI createReviewReply error:', err);
      await lineClient.replyMessage(replyToken, {
        type: 'text',
        text: '申し訳ございません。返信文の作成中にエラーが発生しました。もう一度クチコミを送ってください。',
      });
      return;
    }
    await lineClient.replyMessage(replyToken, {
      type: 'text',
      text: `下書きが完成しました！確認してコピーしてください：\n\n${draft}`,
    });
    return;
  }

  // ---------- モード未選択 ----------
  await lineClient.replyMessage(replyToken, {
    type: 'text',
    text: 'メニューから「メール」か「クチコミ」を選んでくださいね！',
  });
}

// ========== Express サーバー ==========
const app = express();

// Stripe Webhook は必ず「最初」に定義（他ルートの body parser に触られないよう Raw で受ける）
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    console.log('[Stripe Webhook] STRIPE_WEBHOOK_SECRET (先頭8文字):', secret ? `${secret.substring(0, 8)}...` : 'undefined');

    if (!stripe || !secret) {
      console.error('Stripe or STRIPE_WEBHOOK_SECRET is not configured.');
      return res.status(500).send('Stripe is not configured');
    }

    const sig = req.headers['stripe-signature'];
    if (!sig) {
      console.error('Stripe webhook called without signature header.');
      return res.status(400).send('Missing Stripe signature');
    }

    const rawBody = req.body;
    const isBuffer = Buffer.isBuffer(rawBody);
    console.log('[Stripe Webhook] req.body is Buffer:', isBuffer, typeof rawBody);

    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, secret);
    } catch (err) {
      console.error('Stripe webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const eventType = event.type;
    const object = event.data?.object || {};
    console.log('[Stripe Webhook] event.type:', eventType);

    try {
      if (eventType === 'checkout.session.completed') {
        const session = object;
        const lineGroupId = session.metadata?.line_group_id;
        const customerId = session.customer;

        console.log('[Stripe Webhook] checkout.session.completed — line_group_id:', lineGroupId, 'customerId:', customerId);

        if (supabase && lineGroupId && customerId) {
          const { data, error } = await supabase
            .from('line_groups')
            .upsert(
              {
                line_group_id: lineGroupId,
                stripe_customer_id: customerId,
                plan: 'premium',
              },
              { onConflict: 'line_group_id' }
            );
          if (error) {
            console.error('[Stripe Webhook] Supabase upsert 失敗:', error.message, 'code:', error.code, 'details:', error.details);
          } else {
            console.log('[Stripe Webhook] Supabase upsert 成功 — line_group_id:', lineGroupId);
          }
        } else {
          const url = process.env.SUPABASE_URL;
          const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
          console.log('[Stripe Webhook] upsert スキップ — supabase:', !!supabase, 'line_group_id:', lineGroupId, 'customerId:', !!customerId);
          console.log('[Stripe Webhook] 現在の環境変数 — SUPABASE_URL:', url ? '設定あり' : 'undefined', 'SUPABASE_SERVICE_ROLE_KEY:', key ? '設定あり' : 'undefined');
        }
      }

      if (eventType === 'customer.subscription.deleted') {
        const subscription = object;
        const lineGroupId = subscription.metadata?.line_group_id;
        console.log('[Stripe Webhook] customer.subscription.deleted — line_group_id:', lineGroupId);

        if (supabase && lineGroupId) {
          const { error } = await supabase
            .from('line_groups')
            .update({ plan: 'free' })
            .eq('line_group_id', lineGroupId);
          if (error) {
            console.error('[Stripe Webhook] Supabase update(plan=free) 失敗:', error.message, 'code:', error.code, 'details:', error.details);
          } else {
            console.log('[Stripe Webhook] Supabase update(plan=free) 成功 — line_group_id:', lineGroupId);
          }
        } else if (!supabase) {
          console.log('[Stripe Webhook] update スキップ — supabase 未設定。SUPABASE_URL:', !!process.env.SUPABASE_URL, 'SUPABASE_SERVICE_ROLE_KEY:', !!process.env.SUPABASE_SERVICE_ROLE_KEY);
        }
      }
    } catch (err) {
      console.error('Stripe webhook handler error:', err);
    }

    res.json({ received: true });
  }
);

// 以下は JSON body を扱わないため、Stripe の Raw body に干渉しない
// ヘルスチェック（Render や LB 用）
app.get('/', (req, res) => {
  res.send('返信代行 レオンくん is running.');
});

app.get('/success', (req, res) => {
  res.send('<p>お支払いが完了しました。LINEのグループでレオンくんをそのままお使いください。</p>');
});
app.get('/cancel', (req, res) => {
  res.send('<p>お支払いをキャンセルしました。また「課金」と送っていただければお申し込みいただけます。</p>');
});
app.get('/subscription/portal-return', (req, res) => {
  res.send('<p>お手続きありがとうございます。LINEのグループに戻って、レオンくんとの会話を続けていただけます。</p>');
});

// LINE Webhook：署名検証付き。body parser は middleware が担当（Stripe の /webhook とは別）
app.post(
  '/callback',
  middleware({
    channelSecret: lineConfig.channelSecret,
  }),
  async (req, res) => {
    res.sendStatus(200);
    const events = req.body?.events || [];
    for (const event of events) {
      try {
        await handleEvent(event);
      } catch (err) {
        console.error('handleEvent error:', err);
      }
    }
  }
);

app.listen(Number(PORT), HOST, () => {
  console.log(`レオンくん listening on ${HOST}:${PORT}`);
});
