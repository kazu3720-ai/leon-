require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const OpenAI = require('openai').default;

// ========== 設定 ==========
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const lineClient = new Client(lineConfig);

/** レオンくんの魂（System Prompt） */
const LEON_SYSTEM_PROMPT = `あなたは単なる翻訳機ではありません。地方の老舗旅館で、毎日夜中までインバウンド対応に疲弊している女将さんを救うために生まれた、最強のデジタル右腕『レオンくん』です。女将さんの時間を1秒でも削ること、そして日本の旅館の温かい人柄と最高のおもてなしの心を外国人客に完璧に伝えることがあなたの最大の使命です。出力する文章には、女将らしい上品さと温かみを込めてください。`;

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

/** 相手のメールと回答メモから、相手の言語で丁寧な返信文を作成 */
async function createEmailReply(originalEmail, replyMemo) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: LEON_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `【相手から届いたメール（原文）】\n${originalEmail}\n\n【女将さんが書きたい内容のメモ】\n${replyMemo}\n\n上記をもとに、相手のメールの言語に合わせた、丁寧な接客用の返信文を1通で作成してください。挨拶から締めまで、そのままコピーして使える形で出力してください。`,
      },
    ],
  });
  return completion.choices[0].message.content.trim();
}

/** クチコミに対する温かい返信文を作成 */
async function createReviewReply(reviewText) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: LEON_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `以下のお客様のクチコミに対して、旅館の女将として温かく上品な返信文を書いてください。感謝の気持ちと、またのお越しを歓迎する気持ちを込めて、そのままコピーして使える形で1通で出力してください。\n\n---\n${reviewText}`,
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

  const state = getState(userId);

  // ---------- モード切替 ----------
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

// ヘルスチェック（Render や LB 用）
app.get('/', (req, res) => {
  res.send('返信代行 レオンくん is running.');
});

// LINE Webhook：署名検証付き。body parser は middleware が担当するため、ここでは未使用
app.post(
  '/webhook',
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
