const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let CONFIG = {
  SHEET_ID: "1DjoLo9x0Rj6VgVnliPK7WM_juoCJbA8GPbZEa9dhSOU",
  DOMAIN: "https://yourdomain.com",
  ADMIN_CODE: "6294570551",
  PAGE_SIZE: 5
};

const GREETINGS = [
  "🔍 Here are the results I found for you:",
  "🎬 We tracked down your query:",
  "🍿 Found matching titles from database:",
  "✨ Here is what we found:"
];

const CLOSINGS = [
  "👉 Reply with the number to get the link.",
  "👉 Send the number of your choice e.g. 1, 2.",
  "👉 Type the option number to proceed."
];

const getRandom = arr => arr[Math.floor(Math.random() * arr.length)];

let cachedItems = [];
let lastSyncTime = "Never";
const userSessions = new Map();
const adminSessions = new Map();
const dedupeSet = new Set();

async function syncSheetData() {
  try {
    const url = `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/export?format=csv`;
    const res = await axios.get(url, { timeout: 15000 });
    const rows = res.data.split('\n').map(r => {
      return r.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(v => v.replace(/^"\vert{}"$/g, '').trim());
    });

    if (!rows || rows.length === 0) return { success: false, error: "The sheet is completely empty!" };

    const groups = {};
    for (let i = 0; i < rows.length; i++) {
      const rawTitle = String(rows[i][0] || '').trim();
      const thumb = String(rows[i][2] || '').trim();
      if (!rawTitle) continue;

      const rowNum = i + 1;
      const sMatch = rawTitle.match(/s0*(\d+)/i) || rawTitle.match(/season\s*0*(\d+)/i);
      const eMatch = rawTitle.match(/e0*(\d+)/i) || rawTitle.match(/episode\s*0*(\d+)/i);

      if (sMatch) {
        const sNum = parseInt(sMatch[1], 10);
        const eNum = eMatch ? parseInt(eMatch[1], 10) : 1;
        let cleanBase = rawTitle
          .replace(/s0*\d+.*$/i, '')
          .replace(/season\s*0*\d+.*$/i, '')
          .replace(/e0*\d+.*$/i, '')
          .trim()
          .replace(/[-_–]+$/, '')
          .trim();

        const groupKey = `${cleanBase}_S${sNum}`.toLowerCase();

        if (!groups[groupKey]) {
          groups[groupKey] = {
            t: `${cleanBase} Season ${sNum}`,
            searchKey: cleanBase.toLowerCase(),
            p: thumb,
            firstRow: rowNum,
            minEp: eNum
          };
        } else if (eNum < groups[groupKey].minEp) {
          groups[groupKey].minEp = eNum;
          groups[groupKey].firstRow = rowNum;
          if (thumb) groups[groupKey].p = thumb;
        }
      } else {
        const movieKey = `m_${rawTitle}`.toLowerCase();
        if (!groups[movieKey]) {
          groups[movieKey] = {
            t: rawTitle,
            searchKey: rawTitle.toLowerCase(),
            p: thumb,
            firstRow: rowNum,
            minEp: 1
          };
        }
      }
    }

    cachedItems = Object.values(groups).map(g => ({
      r: g.firstRow,
      t: g.t,
      k: g.searchKey,
      p: g.p
    }));

    lastSyncTime = new Date().toLocaleString();
    return { success: true, count: cachedItems.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function calculateSimilarity(str1, str2) {
  function getBigrams(str) {
    const s = str.toLowerCase();
    const v = [];
    for (let i = 0; i < s.length - 1; i++) v.push(s.slice(i, i + 2));
    return v;
  }
  if (str1.length < 2 || str2.length < 2) return 0;
  const v1 = getBigrams(str1);
  const v2 = getBigrams(str2);
  let hit = 0;
  for (let i = 0; i < v1.length; i++) {
    const idx = v2.indexOf(v1[i]);
    if (idx !== -1) { hit++; v2.splice(idx, 1); }
  }
  return Math.round(2.0 * hit / (str1.length + str2.length - 2) * 100);
}

function formatDisplayList(matches, page) {
  const start = page * CONFIG.PAGE_SIZE;
  const slice = matches.slice(start, start + CONFIG.PAGE_SIZE);
  const total = matches.length;

  let text = `🎯 *Found ${total} matching ${total === 1 ? "title" : "titles"}!*\n${getRandom(GREETINGS)}\n\n`;
  slice.forEach((item, idx) => {
    text += `${idx + 1}️⃣ ${item.title}\n`;
  });

  if (start + CONFIG.PAGE_SIZE < total) {
    text += `${slice.length + 1}️⃣ ⏩ *Next See More*\n`;
  }
  text += `\n${getRandom(CLOSINGS)}`;
  return text;
}

app.get('/ping', (req, res) => {
  res.send('Server is alive 24/7');
});

app.all(['/', '/webhook'], async (req, res) => {
  const data = req.method === 'POST' ? req.body : req.query;
  let incomingMsg = (data.query?.message || data.message || data.text || '').replace(/[&,]/g, '').trim();
  let userPhone = (data.query?.sender || data.phone || data.sender || 'default_user').toString().replace(/[^0-9]/g, '');

  if (!incomingMsg) return res.json({ reply: "" });

  const dedupeKey = `${userPhone}_${incomingMsg}`;
  if (dedupeSet.has(dedupeKey)) return res.json({ reply: "" });
  dedupeSet.add(dedupeKey);
  setTimeout(() => dedupeSet.delete(dedupeKey), 3000);

  if (cachedItems.length === 0) await syncSheetData();

  if (incomingMsg === CONFIG.ADMIN_CODE) {
    adminSessions.set(userPhone, { state: "AWAITING_CHOICE", timer: Date.now() });
    return res.json({
      reply: "🎛️ *ADMIN CONTROL PANEL*\n\n1️⃣ Force Sync Now\n2️⃣ Change Google Sheet ID / Link\n3️⃣ Change Domain Link\n4️⃣ View Live System Info\n\n👉 Reply with the option number 1 - 4."
    });
  }

  const adminState = adminSessions.get(userPhone);
  if (adminState && Date.now() - adminState.timer < 300000) {
    if (adminState.state === "AWAITING_CHOICE") {
      if (incomingMsg === "1") {
        const s = await syncSheetData();
        adminSessions.delete(userPhone);
        return res.json({ reply: s.success ? `✅ Synced successfully! Total grouped titles: ${s.count}` : `❌ Failed: ${s.error}` });
      } else if (incomingMsg === "2") {
        adminSessions.set(userPhone, { state: "WAIT_FOR_SHEET", timer: Date.now() });
        return res.json({ reply: "📑 Send the new Google Sheet Link or ID:" });
      } else if (incomingMsg === "3") {
        adminSessions.set(userPhone, { state: "WAIT_FOR_DOMAIN", timer: Date.now() });
        return res.json({ reply: "🔗 Send Website Domain Link:\ne.g. https://mywebsite.com" });
      } else if (incomingMsg === "4") {
        adminSessions.delete(userPhone);
        return res.json({
          reply: `📊 *CURRENT CONFIGURATION*\n\n📑 Sheet ID: ${CONFIG.SHEET_ID}\n🌐 Domain Link: ${CONFIG.DOMAIN}\n🎬 Total Titles/Seasons: ${cachedItems.length}\n🕒 Last Synced: ${lastSyncTime}`
        });
      } else {
        adminSessions.delete(userPhone);
        return res.json({ reply: "❌ Cancelled." });
      }
    } else if (adminState.state === "WAIT_FOR_SHEET") {
      const match = incomingMsg.match(/\/d\/([a-zA-Z0-9-_]+)/);
      CONFIG.SHEET_ID = match ? match[1] : incomingMsg.trim().split(/[/?#]/)[0];
      const s = await syncSheetData();
      adminSessions.delete(userPhone);
      return res.json({ reply: s.success ? `✅ Connected & Synced!\nTotal Groups: ${s.count}` : `❌ Failed: ${s.error}` });
    } else if (adminState.state === "WAIT_FOR_DOMAIN") {
      CONFIG.DOMAIN = incomingMsg.trim().replace(/\/+$/, '').replace(/\?+$/, '');
      adminSessions.delete(userPhone);
      return res.json({ reply: `✅ Domain link updated:\n🔗 ${CONFIG.DOMAIN}` });
    }
  }

  const isNumber = /^[0-9]+$/.test(incomingMsg);
  const session = userSessions.get(userPhone);

  if (isNumber && session && Date.now() - session.timer < 600000) {
    const selectedNum = parseInt(incomingMsg, 10);
    const startIdx = session.page * CONFIG.PAGE_SIZE;
    const currentSlice = session.matches.slice(startIdx, startIdx + CONFIG.PAGE_SIZE);
    const hasMore = startIdx + CONFIG.PAGE_SIZE < session.matches.length;

    if (hasMore && selectedNum === currentSlice.length + 1) {
      session.page += 1;
      session.timer = Date.now();
      return res.json({ reply: formatDisplayList(session.matches, session.page) });
    } else if (selectedNum >= 1 && selectedNum <= currentSlice.length) {
      const item = currentSlice[selectedNum - 1];
      userSessions.delete(userPhone);
      const cleanDomain = CONFIG.DOMAIN.replace(/\/+$/, '').replace(/\?+$/, '');
      const finalLink = `${cleanDomain}?${item.rowId}`;
      const msg = `🎬 *${item.title}*\n\n📥 *Watch / Download Link:*\n${finalLink}\n\n` +
                  (item.thumb ? `🖼 Poster: ${item.thumb}\n\n` : '') +
                  `🍿 *Enjoy watching!*`;
      return res.json({ reply: msg });
    } else {
      return res.json({ reply: "❌ Please reply with a valid option number." });
    }
  }

  const query = incomingMsg.toLowerCase();
  const scoredList = [];

  for (let it of cachedItems) {
    const keyLower = it.k || it.t.toLowerCase();
    const fullLower = it.t.toLowerCase();
    let score = 0;

    if (keyLower === query || fullLower === query) score = 100;
    else if (keyLower.includes(query) || query.includes(keyLower) || fullLower.includes(query)) score = 85;
    else score = calculateSimilarity(query, keyLower);

    if (score >= 25) {
      scoredList.push({ rowId: it.r, title: it.t, thumb: it.p, score });
    }
  }

  scoredList.sort((a, b) => b.score - a.score);

  if (scoredList.length > 0) {
    userSessions.set(userPhone, { matches: scoredList, page: 0, timer: Date.now() });
    return res.json({ reply: formatDisplayList(scoredList, 0) });
  } else {
    return res.json({ reply: `❌ Sorry, no matching titles found for '${incomingMsg}'. Please check the spelling!` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await syncSheetData();
});
          
