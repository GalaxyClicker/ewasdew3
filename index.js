'use strict';

const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');

const { RoleManager } = require('./lib/roles');
const { KitManager } = require('./lib/kits');
const { AdManager } = require('./lib/ads');
const { ThanksManager } = require('./lib/thanks');
const { FeedbackManager } = require('./lib/feedback');
const { StatsManager } = require('./lib/stats');
const { EconomyManager } = require('./lib/economy');
const { AIManager } = require('./lib/ai');
const fun = require('./lib/fun');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const PREFIX = config.prefix || '*';
const OWNER = config.owner;
const CURRENCY = config.currencyName || 'mp';

const roleManager = new RoleManager(path.join(__dirname, config.rolesFile), OWNER);
const kitManager = new KitManager(path.join(__dirname, config.kitsFile));
const adManager = new AdManager(path.join(__dirname, config.adsFile));
const thanksManager = new ThanksManager(path.join(__dirname, config.thanksFile));
const feedbackManager = new FeedbackManager(path.join(__dirname, config.feedbackFile));
const reportsManager = new FeedbackManager(path.join(__dirname, config.reportsFile || 'reports.txt'));

// Quotes: simple flat text file, one quote per line, numbered by line order.
const quotesFilePath = path.join(__dirname, config.quotesFile || 'quotes.txt');
function loadQuotes() {
  if (!fs.existsSync(quotesFilePath)) {
    fs.writeFileSync(quotesFilePath, '# quotes.txt - CenaAirlines quotes\n# One quote per line.\n', 'utf8');
  }
  return fs.readFileSync(quotesFilePath, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}
function addQuote(text) {
  fs.appendFileSync(quotesFilePath, text.replace(/\r?\n/g, ' ') + '\n', 'utf8');
}
const statsManager = new StatsManager(path.join(__dirname, config.statsFile));
const economyManager = new EconomyManager(path.join(__dirname, config.economyFile));
const aiManager = new AIManager(process.env.OPENROUTER_API_KEY || config.openrouterApiKey,config.aiModel);

// Per-player kit cooldown tracking (in-memory only)
const kitCooldowns = new Map(); // lowercase username -> timestamp ms

// Tracks when players were last seen joining/leaving/AFK, parsed from public
// chat system messages. In-memory only, resets on bot restart.
const lastSeen = new Map(); // lowercase username -> { status, timestamp }
const processStartTime = Date.now();

// Economy command cooldowns (in-memory only, resets on restart)
const dailyCooldowns = new Map();
const hourlyCooldowns = new Map();
const workCooldowns = new Map();
const aiCooldowns = new Map();

// Global cooldown for the /tpa + /kill action triggered by *kit
let lastKitActionTime = 0;

// Serializes *entire* kit deliveries (pathfind -> withdraw -> tpa -> wait for
// teleport -> proximity-check -> kill) so a second *kit request never
// interrupts one already in progress, and behaves like a real, visible queue.
const kitQueue = []; // waiting entries: { username, kitName, run }
let currentKitJob = null; // entry currently being served: { username, kitName }
let kitQueueRunning = false;

function queueStatusLines() {
  const lines = [];
  let place = 1;
  if (currentKitJob) {
    lines.push(`Place ${place}: ${currentKitJob.username} - ${currentKitJob.kitName}`);
    place++;
  }
  for (const entry of kitQueue) {
    lines.push(`Place ${place}: ${entry.username} - ${entry.kitName}`);
    place++;
  }
  return lines;
}

function enqueueKitRequest(username, kitName, run, priority) {
  const entry = { username, kitName, run };

  if (priority) {
    // Jump the line - inserted right after whatever's currently being
    // served, ahead of everyone else already waiting.
    kitQueue.unshift(entry);
  } else {
    kitQueue.push(entry);
    const position = (currentKitJob ? 1 : 0) + kitQueue.length;
    if (position > 1) {
      safeReply(username, `You're in queue for "${kitName}" at place ${position}.`);
    }
  }

  runKitQueue();
}

async function runKitQueue() {
  if (kitQueueRunning) return;
  kitQueueRunning = true;
  while (kitQueue.length > 0) {
    const entry = kitQueue.shift();
    currentKitJob = { username: entry.username, kitName: entry.kitName };
    try {
      await entry.run();
    } catch (err) {
      console.log('[CenaAirlines] Kit queue job failed:', err && err.message);
    }
    currentKitJob = null;
  }
  kitQueueRunning = false;
}

let bot;
let reconnecting = false;
let antiAfkInterval = null;

function createBot() {
  bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    version: config.version,
    auth: config.auth || 'offline'
  });

  bot.loadPlugin(pathfinder);

  bot.once('spawn', onSpawn);
  bot.on('forcedMove', logTeleportCoordinates);
  bot.on('whisper', onWhisper);
  bot.on('kicked', onKicked);
  bot.on('error', onError);
  bot.on('end', onEnd);
  bot.on('message', onMessage);

  return bot;
}

// ---------- helpers ----------

function reply(username, message) {
  // ALWAYS reply via /msg (whisper) - never public chat, never coordinates.
  const lines = String(message).split('\n');
  for (const line of lines) {
    bot.chat(`/msg ${username} ${line}`);
    console.log(`[WHISPER] bot -> ${username}: ${line}`);
  }
}

function stripCoords(text) {
  // Safety net: strip anything that looks like a coordinate triple before
  // it could ever be sent, in case a future edit introduces one by mistake.
  return text.replace(/-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?/g, '[hidden]');
}

// Parses public system messages like "X has joined the game.",
// "X left the game.", and "X will join back soon." (AFK) to power *seen.
function trackPresence(text) {
  let match;
  if ((match = text.match(/^(\S+) has joined the game\.$/))) {
    lastSeen.set(match[1].toLowerCase(), { status: 'joined', timestamp: Date.now(), name: match[1] });
  } else if ((match = text.match(/^(\S+) left the game\.$/))) {
    lastSeen.set(match[1].toLowerCase(), { status: 'left', timestamp: Date.now(), name: match[1] });
  } else if ((match = text.match(/^(\S+) will join back soon\.$/))) {
    lastSeen.set(match[1].toLowerCase(), { status: 'went AFK', timestamp: Date.now(), name: match[1] });
  }
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function safeReply(username, message) {
  reply(username, stripCoords(message));
}

// Converts ASCII letters/digits to Unicode Mathematical Sans-Bold characters
// for a "cool font" look in public chat (e.g. "sus" -> "𝘀𝘂𝘀"). Anything
// outside A-Z/a-z/0-9 (spaces, punctuation, emoji, %) passes through as-is.
function toFancyFont(str) {
  const OFFSET_UPPER = 0x1D5D4 - 65;
  const OFFSET_LOWER = 0x1D5EE - 97;
  const OFFSET_DIGIT = 0x1D7EC - 48;
  return String(str).split('').map((ch) => {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(code + OFFSET_UPPER);
    if (code >= 97 && code <= 122) return String.fromCodePoint(code + OFFSET_LOWER);
    if (code >= 48 && code <= 57) return String.fromCodePoint(code + OFFSET_DIGIT);
    return ch;
  }).join('');
}

// Sends fun command output in PUBLIC chat (not /msg) with the fancy font applied.
function funReply(message) {
  const text = stripCoords(String(message));
  const styled = toFancyFont(text);
  bot.chat(styled);
  console.log(`[FUN] bot -> public: ${text}`);
}

// Groups an array of short strings ("parts") into batches that stay under
// maxCharsPerMessage, then whispers each batch to the user, spaced 2 seconds
// apart if more than one batch is needed - avoids tripping anti-spam on
// long outputs like a big queue or the full *config help text.
function sendChunked(username, parts, joiner = ' | ', maxCharsPerMessage = 200) {
  const batches = [];
  let current = [];
  let currentLen = 0;

  for (const part of parts) {
    const partLen = part.length + (current.length > 0 ? joiner.length : 0);
    if (current.length > 0 && currentLen + partLen > maxCharsPerMessage) {
      batches.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(part);
    currentLen += part.length + (current.length > 1 ? joiner.length : 0);
  }
  if (current.length > 0) batches.push(current);

  batches.forEach((batch, index) => {
    setTimeout(() => {
      safeReply(username, batch.join(joiner));
    }, index * 2000);
  });
}

let movements;
let adInterval = null;

function startAdTimer() {
  if (adInterval) clearInterval(adInterval);
  adInterval = setInterval(() => {
    const ad = adManager.getRandom();
    if (ad) {
      bot.chat(ad);
      console.log(`[CenaAirlines] Posted advertisement: ${ad}`);
    }
  }, config.adsIntervalMs || 300000);
}

function stopAdTimer() {
  if (adInterval) {
    clearInterval(adInterval);
    adInterval = null;
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
  } catch (e) {
    console.log('[CenaAirlines] Failed to save config.json:', e.message);
  }
}

function onSpawn() {
  console.log(`[CenaAirlines] Spawned on ${config.host}:${config.port} as ${bot.username}`);
  movements = new Movements(bot);
  // Never let the bot break blocks while pathfinding to a kit/home/etc.
  movements.canDig = false;
  // Don't place blocks either (e.g. bridging with junk from inventory) -
  // it should only ever walk/jump existing terrain.
  movements.canPlace = false;
  movements.canOpenDoors = true;
  movements.allowSprinting = true;
  movements.allowParkour = true;
  movements.allowFreeMotion = true;
  // Treat lava/fire/danger blocks as much costlier so it actually routes
  // around them instead of "the only way is through," and avoid water
  // slowing it down when there's a dry alternative.
  movements.liquidCost = 20;
  bot.pathfinder.setMovements(movements);

  authenticate();

  if (config.adsEnabled) {
    startAdTimer();
  }

  if (config.antiAfk) {
    if (antiAfkInterval) clearInterval(antiAfkInterval);
    antiAfkInterval = setInterval(() => {
      try {
        if (!bot.pathfinder || !bot.pathfinder.isMoving()) {
          bot.setControlState('jump', true);
          setTimeout(() => bot.setControlState('jump', false), 300);
        }
      } catch (e) { /* ignore */ }
    }, config.antiAfkIntervalMs || 60000);
  } else if (antiAfkInterval) {
    clearInterval(antiAfkInterval);
    antiAfkInterval = null;
  }
}

function logTeleportCoordinates() {
  if (!bot || !bot.entity || !bot.entity.position) return;
  const { x, y, z } = bot.entity.position;
  const dimension = bot.game && bot.game.dimension ? ` dimension=${bot.game.dimension}` : '';
  const line = `${new Date().toISOString()} x=${x.toFixed(2)} y=${y.toFixed(2)} z=${z.toFixed(2)}${dimension}`;
  console.log(`[TELEPORT] ${line}`);
  try {
    const logPath = path.join(__dirname, config.coordLogFile || 'coord-log.txt');
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
  } catch (err) {
    console.error('[CenaAirlines] Failed to write teleport coordinate log:', err.message);
  }
}

// AuthMe-style (or similar) /register + /login handling for cracked servers.
// Runs /register on first-ever join (harmless no-op if already registered)
// then /login shortly after so the bot is authenticated either way.
function authenticate() {
  const pass = config.authPassword;
  if (!pass) return;

  setTimeout(() => {
    bot.chat(`/register ${pass} ${pass}`);
    console.log('[CenaAirlines] Sent /register');
  }, config.authRegisterDelayMs || 1500);

  setTimeout(() => {
    bot.chat(`/login ${pass}`);
    console.log('[CenaAirlines] Sent /login');
  }, config.authLoginDelayMs || 3500);
}

// Logs every chat message the bot sees (public chat, system messages, etc.)
// to the console. This does NOT include whispers (those are logged separately
// inside onWhisper) and never triggers command parsing.
function onMessage(jsonMsg, position) {
  try {
    const text = jsonMsg.toString();
    if (text.trim().length === 0) return;
    console.log(`[CHAT] ${text}`);

    trackPresence(text);

    // Public chat is usually formatted as "<Username> message", but rank/clan
    // tags in brackets can appear before AND/or after the name, e.g.
    // "<[♢+] poohead [$]> message" or "<DroneSteve [$]> message". Strip out
    // every [...] segment from inside the angle brackets, then take whatever
    // token is left as the real username - works regardless of where the
    // bracket tags sit.
    const tagMatch = text.match(/^<([^>]+)>\s?(.*)$/);
    if (!tagMatch) return;
    const [, rawTag, chatMessage] = tagMatch;
    const cleanedTag = rawTag.replace(/\[[^\]]*\]/g, '').trim();
    const chatUsername = cleanedTag.split(/\s+/)[0];
    if (!chatUsername || !/^[A-Za-z0-9_]{1,16}$/.test(chatUsername)) return;
    if (!bot || chatUsername.toLowerCase() === bot.username.toLowerCase()) return;
    if (!chatMessage.startsWith(PREFIX)) return;

    handleCommand(chatUsername, chatMessage);
  } catch (e) { /* ignore malformed messages */ }
}

function onKicked(reason) {
  console.log('[CenaAirlines] Kicked:', reason);
}

function onError(err) {
  console.log('[CenaAirlines] Error:', err && err.message ? err.message : err);
}

function onEnd() {
  console.log('[CenaAirlines] Disconnected.');
  if (antiAfkInterval) {
    clearInterval(antiAfkInterval);
    antiAfkInterval = null;
  }
  if (config.autoReconnect && !reconnecting) {
    reconnecting = true;
    setTimeout(() => {
      reconnecting = false;
      createBot();
    }, config.reconnectDelayMs || 10000);
  }
}

// ---------- command dispatch ----------

function onWhisper(username, message) {
  if (!bot || username === bot.username) return;
  console.log(`[WHISPER] ${username} -> bot: ${message}`);
  if (!message.startsWith(PREFIX)) return;
  handleCommand(username, message);
}

function handleCommand(username, message) {
  if (isIgnored(username)) {
    console.log(`[CenaAirlines] Ignored command from ${username} (currently on ignore list).`);
    return;
  }

  if (config.maintenanceMode && !roleManager.hasAtLeast(username, 'Mod')) {
    safeReply(username, 'The bot is currently under maintenance. Please try again later.');
    return;
  }

  const args = message.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = (args.shift() || '').toLowerCase();

  try {
    switch (cmd) {
      case 'help':
        return cmdHelp(username);
      case 'kit':
        return cmdKit(username, args);
      case 'kits':
        return cmdListKits(username);
      case 'queue': {
        if ((args[0] || '').toLowerCase() === 'reset') {
          if (!requireRole(username, 'Admin')) return;
          return cmdConfigResetQueue(username);
        }
        return cmdQueue(username);
      }
      case 'uptime':
        return funReply(`Bot uptime: ${formatDuration(Date.now() - processStartTime)}`);
      case 'ping': {
        const p = bot.players[bot.username];
        const ms = p && typeof p.ping === 'number' ? p.ping : null;
        return funReply(ms !== null ? `My connection ping: ${ms}ms` : 'Ping not available right now.');
      }
      case 'seen': {
        const target = args[0];
        if (!target) return safeReply(username, `Usage: ${PREFIX}seen <user>`);
        if (bot.players[target]) return funReply(`${target} is currently online.`);
        const seen = lastSeen.get(target.toLowerCase());
        if (!seen) return funReply(`I haven't seen ${target} since I've been online.`);
        return funReply(`${seen.name} ${seen.status} ${formatDuration(Date.now() - seen.timestamp)} ago.`);
      }
      case 'feedback': {
        const message = args.join(' ');
        if (!message) return safeReply(username, `Usage: ${PREFIX}feedback <message>`);
        feedbackManager.add(username, message);
        return safeReply(username, 'Thanks for the feedback! It has been recorded.');
      }
      case 'stats': {
        const target = args[0] || username;
        return funReply(`${target} has claimed ${statsManager.getCount(target)} kit(s).`);
      }
      case 'top': {
        const top = statsManager.top(5);
        if (top.length === 0) return funReply('No kits have been claimed yet.');
        const lines = top.map((entry, i) => `#${i + 1} ${entry.name} (${entry.count})`);
        return funReply(lines.join(' | '));
      }
      case 'joke':
        return funReply(fun.joke());
      case 'online': {
        const names = Object.keys(bot.players).filter(n => n.toLowerCase() !== bot.username.toLowerCase());
        return funReply(names.length > 0 ? `Online (${names.length}): ${names.join(', ')}` : 'No one else is online.');
      }
      case 'whois': {
        const target = args[0] || username;
        const role = roleManager.getRole(target);
        const balance = economyManager.getBalance(target);
        const kitsClaimed = statsManager.getCount(target);
        return funReply(`${target} - Role: ${role} | ${CURRENCY}: ${balance} | Kits claimed: ${kitsClaimed}`);
      }
      case 'rules':
        return safeReply(username, config.rulesText || 'No rules have been set. Ask an admin to configure config.rulesText.');
      case 'report': {
        const target = args[0];
        const reason = args.slice(1).join(' ');
        if (!target || !reason) return safeReply(username, `Usage: ${PREFIX}report <user> <reason>`);
        reportsManager.add(username, `reported ${target}: ${reason}`);
        return safeReply(username, 'Report submitted. Thanks for helping keep the server clean.');
      }
      case 'addquote': {
        const text = args.join(' ');
        if (!text) return safeReply(username, `Usage: ${PREFIX}addquote <text>`);
        addQuote(text);
        const quotes = loadQuotes();
        return funReply(`Quote #${quotes.length} added!`);
      }
      case 'quote': {
        const quotes = loadQuotes();
        if (quotes.length === 0) return safeReply(username, `No quotes yet. Add one with ${PREFIX}addquote <text>`);
        let idx;
        if (args[0]) {
          idx = parseInt(args[0], 10);
          if (!Number.isInteger(idx) || idx < 1 || idx > quotes.length) {
            return safeReply(username, `Invalid quote number. There are ${quotes.length} quote(s).`);
          }
        } else {
          idx = 1 + Math.floor(Math.random() * quotes.length);
        }
        return funReply(`Quote #${idx}: "${quotes[idx - 1]}"`);
      }
      case 'mock': {
        const text = args.join(' ');
        if (!text) return safeReply(username, `Usage: ${PREFIX}mock <text>`);
        const mocked = text.split('').map((c, i) => (i % 2 === 0 ? c.toLowerCase() : c.toUpperCase())).join('');
        return funReply(mocked);
      }
      case 'reverse': {
        const text = args.join(' ');
        if (!text) return safeReply(username, `Usage: ${PREFIX}reverse <text>`);
        return funReply(text.split('').reverse().join(''));
      }
      case 'choose': {
        if (args.length < 2) return safeReply(username, `Usage: ${PREFIX}choose <option1> <option2> ...`);
        return funReply(`I choose: ${args[Math.floor(Math.random() * args.length)]}`);
      }
      case 'hack': {
        const target = args[0];
        if (!target) return safeReply(username, `Usage: ${PREFIX}hack <user>`);
        return funReply(`Hacking ${target}... [##########] 100% - jk, that's not how this works.`);
      }
      case 'calc': {
        const expr = args.join(' ');
        if (!expr) return safeReply(username, `Usage: ${PREFIX}calc <expression>`);
        if (!/^[0-9+\-*/(). ]+$/.test(expr)) return safeReply(username, 'Only numbers and + - * / ( ) are allowed.');
        try {
          const result = Function(`"use strict"; return (${expr})`)();
          return funReply(`${expr} = ${result}`);
        } catch (e) {
          return safeReply(username, 'Invalid expression.');
        }
      }
      case 'time':
        return funReply(`Server time: ${new Date().toLocaleString()}`);
      case 'echo': {
        const text = args.join(' ');
        if (!text) return safeReply(username, `Usage: ${PREFIX}echo <text>`);
        return funReply(text);
      }
      case 'ai':
        return cmdAi(username, args);
      case 'mp':
      case 'bal': {
        const target = args[0] || username;
        return funReply(`${target} has ${economyManager.getBalance(target)} ${CURRENCY}.`);
      }
      case 'daily': {
        const lower = username.toLowerCase();
        const cd = config.dailyCooldownMs || 86400000;
        const last = dailyCooldowns.get(lower) || 0;
        const now = Date.now();
        if (now - last < cd) {
          return safeReply(username, `You already claimed your daily. Come back in ${formatDuration(cd - (now - last))}.`);
        }
        dailyCooldowns.set(lower, now);
        const amount = config.dailyAmount || 500;
        economyManager.addBalance(username, amount);
        return funReply(`${username} claimed their daily and earned ${amount} ${CURRENCY}!`);
      }
      case 'hourly': {
        const lower = username.toLowerCase();
        const cd = config.hourlyCooldownMs || 3600000;
        const last = hourlyCooldowns.get(lower) || 0;
        const now = Date.now();
        if (now - last < cd) {
          return safeReply(username, `You already claimed your hourly. Come back in ${formatDuration(cd - (now - last))}.`);
        }
        hourlyCooldowns.set(lower, now);
        const amount = config.hourlyAmount || 50;
        economyManager.addBalance(username, amount);
        return funReply(`${username} claimed their hourly and earned ${amount} ${CURRENCY}!`);
      }
      case 'work': {
        const lower = username.toLowerCase();
        const cd = config.workCooldownMs || 300000;
        const last = workCooldowns.get(lower) || 0;
        const now = Date.now();
        if (now - last < cd) {
          return safeReply(username, `You're on cooldown. Try working again in ${formatDuration(cd - (now - last))}.`);
        }
        workCooldowns.set(lower, now);
        const min = config.workMinAmount || 10;
        const max = config.workMaxAmount || 100;
        const amount = min + Math.floor(Math.random() * (max - min + 1));
        economyManager.addBalance(username, amount);
        return funReply(fun.workFlavor(username, amount, CURRENCY));
      }
      case 'pay': {
        const [target, amountStr] = args;
        const amount = parseInt(amountStr, 10);
        if (!target || !Number.isInteger(amount) || amount <= 0) {
          return safeReply(username, `Usage: ${PREFIX}pay <user> <amount>`);
        }
        if (target.toLowerCase() === username.toLowerCase()) {
          return safeReply(username, "You can't pay yourself.");
        }
        const balance = economyManager.getBalance(username);
        if (balance < amount) {
          return safeReply(username, `You don't have enough ${CURRENCY}. Balance: ${balance}`);
        }
        economyManager.subtractBalance(username, amount);
        economyManager.addBalance(target, amount);
        return funReply(`${username} paid ${target} ${amount} ${CURRENCY}!`);
      }
      case 'gamble': {
        const amount = parseInt(args[0], 10);
        if (!Number.isInteger(amount) || amount <= 0) {
          return safeReply(username, `Usage: ${PREFIX}gamble <amount>`);
        }
        const balance = economyManager.getBalance(username);
        if (balance < amount) {
          return safeReply(username, `You don't have enough ${CURRENCY}. Balance: ${balance}`);
        }
        const win = Math.random() < 0.5;
        if (win) {
          economyManager.addBalance(username, amount);
          return funReply(`${username} gambled ${amount} ${CURRENCY} and WON! New balance: ${economyManager.getBalance(username)}`);
        }
        economyManager.subtractBalance(username, amount);
        return funReply(`${username} gambled ${amount} ${CURRENCY} and LOST it all! New balance: ${economyManager.getBalance(username)}`);
      }
      case 'mpleaderboard': {
        const top = economyManager.top(5);
        if (top.length === 0) return funReply(`No one has any ${CURRENCY} yet.`);
        const lines = top.map((entry, i) => `#${i + 1} ${entry.name} (${entry.balance})`);
        return funReply(`${CURRENCY.toUpperCase()} Leaderboard: ${lines.join(' | ')}`);
      }
      case 'slots': {
        const amount = parseInt(args[0], 10);
        if (!Number.isInteger(amount) || amount <= 0) {
          return safeReply(username, `Usage: ${PREFIX}slots <amount>`);
        }
        const balance = economyManager.getBalance(username);
        if (balance < amount) {
          return safeReply(username, `You don't have enough ${CURRENCY}. Balance: ${balance}`);
        }
        economyManager.subtractBalance(username, amount);
        const reels = fun.spinSlots();
        const multiplier = fun.slotsPayoutMultiplier(reels);
        const display = reels.join(' ');
        if (multiplier > 0) {
          const payout = amount * multiplier;
          economyManager.addBalance(username, payout);
          return funReply(`${username} spun [${display}] and WON ${payout} ${CURRENCY}! (${multiplier}x)`);
        }
        return funReply(`${username} spun [${display}] and lost ${amount} ${CURRENCY}.`);
      }
      case 'roulette': {
        const amount = parseInt(args[0], 10);
        const bet = args[1];
        const preCheck = bet ? fun.rouletteResolve(bet, { number: -1, color: 'none' }) : { valid: false };
        if (!Number.isInteger(amount) || amount <= 0 || !preCheck.valid) {
          return safeReply(username, `Usage: ${PREFIX}roulette <amount> <red|black|green|0-36>`);
        }
        const balance = economyManager.getBalance(username);
        if (balance < amount) {
          return safeReply(username, `You don't have enough ${CURRENCY}. Balance: ${balance}`);
        }
        economyManager.subtractBalance(username, amount);
        const result = fun.spinRoulette();
        const resolved = fun.rouletteResolve(bet, result);
        if (resolved.win) {
          const payout = amount * resolved.multiplier;
          economyManager.addBalance(username, payout);
          return funReply(`${username} bet ${amount} ${CURRENCY} on ${bet} - ball landed on ${result.number} (${result.color}) - WON ${payout} ${CURRENCY}!`);
        }
        return funReply(`${username} bet ${amount} ${CURRENCY} on ${bet} - ball landed on ${result.number} (${result.color}) - LOST.`);
      }
      case 'feedbacklist':
      case 'clearfeedback':
      case 'kitset':
      case 'delkit':
      case 'come':
      case 'tpahere':
      case 'sethome':
      case 'delhome':
      case 'setrole':
      case 'roles':
      case 'listroles':
      case 'reload':
      case 'broadcast':
        return safeReply(username, `That's now under ${PREFIX}config - try ${PREFIX}config help`);
      case 'myrole':
        return safeReply(username, `Your role: ${roleManager.getRole(username)}`);
      case 'config':
        return cmdConfig(username, args);
      case 'pp':
        return funReply(fun.ppCommand(args[0] || username, roleManager.hasAtLeast(args[0] || username, 'Mod')));
      case 'howgay':
        return funReply(fun.howGay(args[0] || username, roleManager.hasAtLeast(args[0] || username, 'Mod')));
      case 'rate':
        return funReply(fun.rate(args[0] || username, roleManager.hasAtLeast(args[0] || username, 'Mod')));
      case 'iq':
        return funReply(fun.iq(args[0] || username, roleManager.hasAtLeast(args[0] || username, 'Mod')));
      case 'simprate':
        return funReply(fun.simpRate(args[0] || username, roleManager.hasAtLeast(args[0] || username, 'Mod')));
      case 'clout':
        return funReply(fun.clout(args[0] || username, roleManager.hasAtLeast(args[0] || username, 'Mod')));
      case 'sus':
        return funReply(fun.sus(args[0] || username, roleManager.hasAtLeast(args[0] || username, 'Mod')));
      case 'virgin':
        return funReply(fun.virgin(args[0] || username, roleManager.hasAtLeast(args[0] || username, 'Mod')));
      case 'ship': {
        const [a, b] = args;
        if (!a || !b) return safeReply(username, `Usage: ${PREFIX}ship <user1> <user2>`);
        return funReply(fun.ship(a, b, roleManager.hasAtLeast(a, 'Mod'), roleManager.hasAtLeast(b, 'Mod')));
      }
      case 'coinflip':
        return funReply(fun.coinFlip());
      case 'roll':
        return funReply(fun.roll(parseInt(args[0], 10)));
      case '8ball': {
        const question = args.join(' ');
        if (!question) return safeReply(username, `Usage: ${PREFIX}8ball <question>`);
        return funReply(fun.eightBall(question));
      }
      case 'insult':
        if (!args[0]) return safeReply(username, `Usage: ${PREFIX}insult <user>`);
        return funReply(fun.insult(args[0], roleManager.hasAtLeast(args[0], 'Mod')));
      case 'compliment':
        if (!args[0]) return safeReply(username, `Usage: ${PREFIX}compliment <user>`);
        return funReply(fun.compliment(args[0], roleManager.hasAtLeast(args[0], 'Mod')));
      case 'slap':
        if (!args[0]) return safeReply(username, `Usage: ${PREFIX}slap <user>`);
        return funReply(fun.slap(username, args[0], roleManager.hasAtLeast(args[0], 'Mod')));
      case 'hug':
        if (!args[0]) return safeReply(username, `Usage: ${PREFIX}hug <user>`);
        return funReply(fun.hug(username, args[0], roleManager.hasAtLeast(args[0], 'Mod')));
      case 'fact':
        return funReply(fun.fact());
      case 'rps':
        return funReply(fun.rps(args[0], roleManager.hasAtLeast(username, 'Mod')));
      default:
        return safeReply(username, `Unknown command "${cmd}". Try ${PREFIX}help`);
    }
  } catch (err) {
    console.log('[CenaAirlines] Command error:', err);
    safeReply(username, 'Something went wrong running that command.');
  }
}

function requireRole(username, role) {
  if (!roleManager.hasAtLeast(username, role)) {
    safeReply(username, `You need ${role}+ permissions to use that command.`);
    return false;
  }
  return true;
}

// Checks whether a user is currently blocked from using the bot, either
// because they're individually ignored, or because "ignore others" is on
// and they aren't Mod+ (Mod+ can never be blocked by "others").
function isIgnored(username) {
  if (roleManager.getRole(username) === 'Owner') return false;
  const lower = username.toLowerCase();
  const list = config.ignoredUsers || [];
  if (list.includes(lower)) return true;
  if (config.ignoreOthers && !roleManager.hasAtLeast(username, 'Mod')) return true;
  return false;
}

// ---------- commands ----------

const FUN_COMMANDS = [
  `${PREFIX}pp`, `${PREFIX}howgay`, `${PREFIX}rate`, `${PREFIX}iq`, `${PREFIX}simprate`,
  `${PREFIX}clout`, `${PREFIX}sus`, `${PREFIX}virgin`, `${PREFIX}ship`, `${PREFIX}coinflip`,
  `${PREFIX}roll`, `${PREFIX}8ball`, `${PREFIX}insult`, `${PREFIX}compliment`,
  `${PREFIX}slap`, `${PREFIX}hug`, `${PREFIX}fact`, `${PREFIX}rps`
];

function cmdHelp(username) {
  const page1 = [`${PREFIX}help`, `${PREFIX}kit`, `${PREFIX}kits`, `${PREFIX}queue`, `${PREFIX}myrole`, `${PREFIX}uptime`, `${PREFIX}ping`, `${PREFIX}seen`, `${PREFIX}feedback`, `${PREFIX}stats`, `${PREFIX}top`, `${PREFIX}ai`, `${PREFIX}online`, `${PREFIX}whois`, `${PREFIX}rules`, `${PREFIX}report`, `${PREFIX}addquote`, `${PREFIX}quote`, `${PREFIX}mock`, `${PREFIX}reverse`, `${PREFIX}choose`, `${PREFIX}hack`, `${PREFIX}calc`, `${PREFIX}time`, `${PREFIX}echo`];

  if (roleManager.hasAtLeast(username, 'Mod')) {
    page1.push(`${PREFIX}config (all admin/mod commands live here now - try ${PREFIX}config help)`);
  }

  const funPage = [...FUN_COMMANDS, `${PREFIX}joke`];
  const economyPage = [`${PREFIX}mp`, `${PREFIX}bal`, `${PREFIX}daily`, `${PREFIX}hourly`, `${PREFIX}work`, `${PREFIX}pay`, `${PREFIX}gamble`, `${PREFIX}slots`, `${PREFIX}roulette`, `${PREFIX}mpleaderboard`, `${PREFIX}queue reset (Admin+)`];
  const pages = [page1, funPage, economyPage];

  // Send each page 2 seconds apart so this never trips server anti-spam.
  pages.forEach((page, index) => {
    setTimeout(() => {
      safeReply(username, `Commands (page ${index + 1}/${pages.length}): ${page.join(' ')}`);
    }, index * 2000);
  });
}

function cmdListKits(username) {
  const kits = roleManager.getAllowedKits(username, kitManager.list());
  if (kits.length === 0) {
    return safeReply(username, 'No kits are available to your role.');
  }
  const parts = kits.map(k => `${k.name} (${k.cost || 0} ${CURRENCY})`);
  safeReply(username, `Available kits: ${parts.join(', ')}`);
}

function cmdQueue(username) {
  const lines = queueStatusLines();
  if (lines.length === 0) {
    return safeReply(username, 'The kit queue is empty.');
  }
  sendChunked(username, lines);
}

// Returns the discount fraction (0-1) for a user: dev discount takes
// priority over friend discount if they're somehow both (they don't stack).
function getDiscountForUser(username) {
  const lower = username.toLowerCase();
  if ((config.devUsers || []).some(u => u.toLowerCase() === lower)) {
    return config.devDiscount ?? 0.30;
  }
  if ((config.friendUsers || []).some(u => u.toLowerCase() === lower)) {
    return config.friendDiscount ?? 0.15;
  }
  return 0;
}

// *ai <message> - Default+. Asks Cerebras and whispers back the answer, split
// across multiple 2-second-spaced messages if it's long. Requires
// CEREBRAS_API_KEY (env var, preferred) or config.cerebrasApiKey to be set.
async function cmdAi(username, args) {
  const prompt = args.join(' ');
  if (!prompt) return safeReply(username, `Usage: ${PREFIX}ai <message>`);

  if (!aiManager.enabled) {
    return safeReply(username, `${PREFIX}ai isn't configured yet - set the CEREBRAS_API_KEY environment variable (or cerebrasApiKey in config.json) and restart the bot.`);
  }

  const lower = username.toLowerCase();
  const cd = config.aiCooldownMs || 10000;
  const now = Date.now();
  const last = aiCooldowns.get(lower) || 0;
  if (now - last < cd) {
    return safeReply(username, `Please wait ${formatDuration(cd - (now - last))} before asking again.`);
  }
  aiCooldowns.set(lower, now);

  try {
    const answer = await aiManager.ask(prompt);
    const parts = answer.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    sendChunked(username, parts.length > 0 ? parts : [answer], ' ', 200);
  } catch (err) {
    console.log('[CenaAirlines] AI request failed:', err && err.message);
    safeReply(username, "Sorry, that AI request failed. Try again in a bit.");
  }
}

async function cmdKit(username, args) {
  const kitName = args.join(' ');
  if (!kitName) return safeReply(username, `Usage: ${PREFIX}kit <kitname>`);

  const kit = kitManager.getKit(kitName);
  if (!kit) return safeReply(username, `Kit "${kitName}" does not exist.`);
  if (!roleManager.canUseKit(username, kit.name)) {
    return safeReply(username, `Your ${roleManager.getRole(username)} role cannot claim kit "${kit.name}".`);
  }

  if (!config.kitDeliveryEnabled) {
    return safeReply(username, `Kit "${kit.name}" is registered but delivery is currently disabled.`);
  }

  const baseCost = kit.cost || 0;
  const discount = getDiscountForUser(username);
  const cost = discount > 0 ? Math.max(0, Math.round(baseCost * (1 - discount))) : baseCost;
  if (cost > 0) {
    const balance = economyManager.getBalance(username);
    if (balance < cost) {
      return safeReply(username, `You need ${cost} ${CURRENCY} for kit "${kit.name}" but only have ${balance}.`);
    }
  }

  const lower = username.toLowerCase();
  const now = Date.now();
  const cooldownSeconds = config.kitCooldownSeconds === undefined ? 60 : config.kitCooldownSeconds;
  const cooldownMs = cooldownSeconds * 1000;
  const last = kitCooldowns.get(lower) || 0;
  if (now - last < cooldownMs) {
    const remaining = Math.ceil((cooldownMs - (now - last)) / 1000);
    return safeReply(username, `You must wait ${remaining}s before claiming another kit.`);
  }
  kitCooldowns.set(lower, now);

  enqueueKitRequest(username, kit.name, async () => {
    safeReply(username, `Fetching kit "${kit.name}"... this may take a moment.`);
    const result = await collectKitItem(kit);

    if (!result.success) {
      if (result.reason === 'no-chest') {
        return safeReply(username, `I reached kit "${kit.name}" but couldn't find a chest there.`);
      }
      if (result.reason === 'empty') {
        return safeReply(username, `The chest for kit "${kit.name}" is empty.`);
      }
      return safeReply(username, `I couldn't reach kit "${kit.name}" right now. Please try again later.`);
    }

    // Charge now that the item has actually left the chest - not before,
    // so a failed/unreachable kit never costs the player anything.
    if (cost > 0) {
      economyManager.subtractBalance(username, cost);
      const discountNote = discount > 0 ? ` (${Math.round(discount * 100)}% discount applied)` : '';
      safeReply(username, `Charged ${cost} ${CURRENCY} for kit "${kit.name}"${discountNote}. New balance: ${economyManager.getBalance(username)}.`);
    }

    safeReply(username, `Got kit "${kit.name}"! Come stand near me - I'll drop it once teleportation finishes.`);
    await triggerTpaKill(username);
  });
}

// Walks to the kit's stored location and withdraws one item from the nearest
// chest into the bot's own inventory. Does NOT toss/drop anything itself -
// delivery happens purely through /kill once the player is detected nearby
// (see triggerTpaKill), never by simulating a manual drop/toss action.

// Wraps bot.pathfinder.goto() with a "stuck" watchdog: if the bot's position
// hasn't meaningfully changed in stuckTimeoutMs while still trying to reach
// the goal (the classic "walking straight into a wall forever" bug), this
// cancels the goal and throws instead of letting it flail indefinitely.
async function gotoSafely(goal, stuckTimeoutMs) {
  const timeout = stuckTimeoutMs || config.pathfinderStuckTimeoutMs || 8000;
  let lastPos = bot.entity.position.clone();
  let lastMoveTime = Date.now();

  const stuckCheck = setInterval(() => {
    if (!bot.entity) return;
    const dist = bot.entity.position.distanceTo(lastPos);
    if (dist > 0.3) {
      lastPos = bot.entity.position.clone();
      lastMoveTime = Date.now();
      return;
    }
    if (Date.now() - lastMoveTime > timeout) {
      console.log('[CenaAirlines] Pathfinder appears stuck (no movement) - cancelling goal.');
      bot.pathfinder.setGoal(null);
      bot.clearControlStates();
    }
  }, 1000);

  try {
    await bot.pathfinder.goto(goal);
  } finally {
    clearInterval(stuckCheck);
  }
}

async function collectKitItem(kit) {
  let container = null;
  try {
    const goal = new goals.GoalNear(kit.x, kit.y, kit.z, config.kitReachDistance || 1);
    await gotoSafely(goal);

    // Anchor the chest search to the KIT'S stored coordinates, not wherever
    // the bot happens to end up standing. Searching from the bot's own
    // position (with a loose radius) could grab a completely different
    // kit's chest if two kits are stored near each other - which is exactly
    // what was causing every request to fetch whichever chest was closest
    // (e.g. always "pvp") instead of the one actually requested.
    const kitPoint = new Vec3(kit.x, kit.y, kit.z);

    let chestBlock = bot.blockAt(kitPoint.floored());
    if (!chestBlock || (chestBlock.name !== 'chest' && chestBlock.name !== 'trapped_chest')) {
      chestBlock = bot.findBlock({
        point: kitPoint,
        matching: (block) => block && (block.name === 'chest' || block.name === 'trapped_chest'),
        maxDistance: 2
      });
    }
    if (!chestBlock) return { success: false, reason: 'no-chest' };

    container = await bot.openContainer(chestBlock);
    const items = container.containerItems().filter(i => i && i.count > 0);
    if (items.length === 0) {
      container.close();
      container = null;
      return { success: false, reason: 'empty' };
    }

    // Pick whatever the first available stack is, then total up every slot
    // that matches that same item so we know the real total available -
    // not just what's sitting in one slot.
    const first = items[0];
    const totalAvailable = items
      .filter(i => i.type === first.type && i.metadata === first.metadata)
      .reduce((sum, i) => sum + i.count, 0);

    const amount = Math.max(1, config.kitWithdrawAmount || 1);
    const toWithdraw = Math.min(amount, totalAvailable);

    // window.withdraw pulls from multiple matching slots automatically if needed.
    await container.withdraw(first.type, first.metadata, toWithdraw);
    container.close();
    container = null;
    return { success: true, withdrawn: toWithdraw };
  } catch (err) {
    console.log('[CenaAirlines] collectKitItem failed:', err && err.message);
    if (container) {
      try {
        container.close();
      } catch (closeError) {
        console.error('[CenaAirlines] Failed to close kit container:', closeError.message);
      }
    }
    return { success: false, reason: 'error' };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Waits for one of the outcomes of a /tpa send: either the server's
// "Teleportation will commence in X seconds" success message, its
// "Error: Time before next teleport: ..." cooldown-rejection message, or
// nothing at all within detectMs (timeout).
function waitForTpaOutcome(detectMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timeout;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      bot.removeListener('message', handler);
      resolve(result);
    };

    const handler = (jsonMsg) => {
      try {
        const text = jsonMsg.toString();

        const commenceMatch = text.match(/Teleportation will commence in (\d+) seconds?/i);
        if (commenceMatch) {
          return finish({ type: 'commence', seconds: parseInt(commenceMatch[1], 10) || 0 });
        }

        const cooldownMatch = text.match(/Time before next teleport:\s*(now|\d+)\s*(seconds?)?/i);
        if (cooldownMatch) {
          const raw = cooldownMatch[1].toLowerCase();
          const seconds = raw === 'now' ? 1 : (parseInt(raw, 10) || 1);
          return finish({ type: 'cooldown', seconds });
        }

        if (/cancelled your teleport request|request has expired|is not online/i.test(text)) {
          return finish({ type: 'cancelled' });
        }
      } catch (e) { /* ignore */ }
    };

    bot.on('message', handler);
    timeout = setTimeout(() => finish({ type: 'timeout' }), detectMs);
  });
}

// Sends /tpa <username> and actually confirms it worked before proceeding.
// If the server rejects it with a teleport cooldown error, waits out that
// cooldown and retries (up to kitTeleportMaxRetries) instead of blindly
// assuming the teleport happened. Resolves true once "Teleportation will
// commence..." is seen (and the min-wait/announced countdown has elapsed),
// or false if it never succeeds after all retries.
async function sendTpaAndWait(username) {
  const detectMs = config.kitTeleportDetectMs || 8000;
  const minWaitMs = config.kitTeleportMinWaitMs || 15000;
  const maxRetries = config.kitTeleportMaxRetries || 5;
  const cooldownFallbackSec = config.kitTeleportCooldownFallbackSec || 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const outcomePromise = waitForTpaOutcome(detectMs);
    bot.chat(`/tpa ${username}`);
    console.log(`[CenaAirlines] Sent /tpa ${username} (attempt ${attempt}/${maxRetries})`);

    const outcome = await outcomePromise;

    if (outcome.type === 'commence') {
      console.log(`[CenaAirlines] Detected teleport countdown: ${outcome.seconds}s`);
      await sleep(Math.max(minWaitMs, outcome.seconds * 1000));
      return true;
    }

    if (outcome.type === 'cooldown') {
      const waitSec = outcome.seconds || cooldownFallbackSec;
      console.log(`[CenaAirlines] /tpa rejected (teleport cooldown ~${waitSec}s), retrying after wait.`);
      await sleep((waitSec + 1) * 1000);
      continue;
    }

    if (outcome.type === 'cancelled') {
      console.log(`[CenaAirlines] /tpa to ${username} was cancelled/expired, retrying.`);
      await sleep(2000);
      continue;
    }

    // timeout - no message seen either way. Fall back to the old minimum-wait
    // behavior for this attempt rather than looping forever on silence.
    console.log('[CenaAirlines] No teleport confirmation/cooldown message seen, assuming it worked.');
    await sleep(minWaitMs);
    return true;
  }

  console.log(`[CenaAirlines] Gave up trying to teleport ${username} after ${maxRetries} attempts.`);
  return false;
}

// Waits for the bot to actually be back at base after /kill, before the queue
// moves on to the next person. Two detection paths, whichever fires first:
//  1. The server's custom death message ("CenaAirlines listened to their
//     depression") - once seen, waits an extra kitRespawnMessageWaitMs (3s).
//  2. mineflayer's own 'respawn' event - once fired, waits a short
//     kitRespawnFallbackWaitMs stabilization buffer.
// A hard timeout (kitRespawnTimeoutMs) prevents the queue from stalling
// forever if neither ever fires.
function waitForRespawn() {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (extraWaitMs) => {
      if (settled) return;
      settled = true;
      bot.removeListener('respawn', respawnHandler);
      bot.removeListener('message', messageHandler);
      setTimeout(resolve, extraWaitMs);
    };

    const messageHandler = (jsonMsg) => {
      try {
        const text = jsonMsg.toString();
        if (text.includes('CenaAirlines listened to their depression')) {
          console.log('[CenaAirlines] Detected death message, waiting before continuing.');
          finish(config.kitRespawnMessageWaitMs || 3000);
        }
      } catch (e) { /* ignore */ }
    };

    const respawnHandler = () => {
      console.log('[CenaAirlines] Bot respawn event detected.');
      finish(config.kitRespawnFallbackWaitMs || 1000);
    };

    bot.on('message', messageHandler);
    bot.on('respawn', respawnHandler);

    // Safety net so a missed death message/respawn event can't stall the queue forever.
    setTimeout(() => finish(0), config.kitRespawnTimeoutMs || 10000);
  });
}

// Sends /tpa <username> - retrying through server teleport-cooldown errors
// via sendTpaAndWait() rather than assuming a single /tpa always lands. Once
// teleportation is confirmed, watches for that player to be within
// kitTpaKillRadius blocks before sending /kill. Only fires /kill once it has
// *confirmed* the player is in range - never on a timer alone. If the player
// never comes into range within kitTpaKillTimeoutMs, it gives up.
// The 20s global cooldown (kitActionGlobalDelayMs) applies ONLY to the /kill
// itself - if a /kill happened recently, this just keeps polling until the
// cooldown clears (or it times out).
// This function only resolves once the whole sequence is done, which is what
// makes the kit queue actually wait its turn instead of overlapping.
async function triggerTpaKill(username) {
  const teleported = await sendTpaAndWait(username);
  if (!teleported) {
    safeReply(username, `Couldn't get you teleported in - try running ${PREFIX}kit again in a moment.`);
    return;
  }

  const radius = config.kitTpaKillRadius || 5;
  const checkIntervalMs = config.kitTpaKillCheckIntervalMs || 500;
  const timeoutMs = config.kitTpaKillTimeoutMs || 30000;
  const globalDelay = config.kitActionGlobalDelayMs || 20000;
  const startedAt = Date.now();
  let killSent = false;

  await new Promise((resolve) => {
    const interval = setInterval(() => {
      try {
        if (Date.now() - startedAt > timeoutMs) {
          clearInterval(interval);
          console.log(`[CenaAirlines] Gave up waiting for ${username} to be within ${radius} blocks; /kill not sent.`);
          return resolve();
        }

        const player = bot.players[username];
        const entity = player && player.entity;
        if (!entity || !bot.entity) return; // not visible/loaded yet, keep waiting

        const distance = bot.entity.position.distanceTo(entity.position);
        if (distance > radius) return; // not close enough yet, keep waiting

        if (Date.now() - lastKitActionTime < globalDelay) return; // in range, but /kill is on cooldown - keep waiting

        clearInterval(interval);
        lastKitActionTime = Date.now();
        bot.chat('/kill');
        killSent = true;
        console.log(`[CenaAirlines] Confirmed ${username} within ${radius} blocks (${distance.toFixed(2)}) - sent /kill`);

        if (config.thanksEnabled) {
          const thanksMsg = thanksManager.getRandom();
          if (thanksMsg) {
            bot.chat(thanksMsg);
            console.log(`[CenaAirlines] Posted thank-you: ${thanksMsg}`);
          }
        }
        statsManager.increment(username);

        resolve();
      } catch (e) {
        // ignore transient errors (e.g. entity despawn mid-check) and keep polling
      }
    }, checkIntervalMs);
  });

  // Only wait for the bot to actually respawn back at base if /kill was
  // really sent - no point waiting for a respawn that's never coming.
  if (killSent) {
    await waitForRespawn();
    // Extra buffer after respawning before the NEXT /tpa gets sent (for this
    // or the next queued player), so we don't hit the server's own
    // teleport-cooldown rejection right after dying.
    const postRespawnDelay = config.kitPostRespawnTpaDelayMs || 10000;
    console.log(`[CenaAirlines] Waiting ${postRespawnDelay}ms after respawn before next /tpa.`);
    await sleep(postRespawnDelay);
  }
}

function cmdKitSet(username, args) {
  if (!requireRole(username, 'Admin')) return;
  const [xs, ys, zs, ...rest] = args;
  if (!xs || !ys || !zs || rest.length < 2) {
    return safeReply(username, `Usage: ${PREFIX}kitset <x> <y> <z> <kitname> <cost>`);
  }
  const costStr = rest[rest.length - 1];
  const kitName = rest.slice(0, -1).join(' ');
  const x = Number(xs), y = Number(ys), z = Number(zs);
  const cost = Number(costStr);
  if (![x, y, z].every(Number.isFinite)) {
    return safeReply(username, 'Coordinates must be numbers.');
  }
  if (!kitName) {
    return safeReply(username, 'Kit name is required.');
  }
  if (!Number.isFinite(cost) || cost < 0) {
    return safeReply(username, 'Cost must be a non-negative number.');
  }
  kitManager.setKit(kitName, x, y, z, cost);
  // Confirm WITHOUT echoing the coordinates back.
  safeReply(username, `Kit "${kitName}" has been saved with a cost of ${cost} ${CURRENCY}.`);
}

function cmdDelKit(username, args) {
  if (!requireRole(username, 'Admin')) return;
  const kitName = args.join(' ');
  if (!kitName) return safeReply(username, `Usage: ${PREFIX}delkit <kitname>`);
  const existed = kitManager.deleteKit(kitName);
  safeReply(username, existed ? `Kit "${kitName}" deleted.` : `Kit "${kitName}" does not exist.`);
}

function cmdCome(username) {
  if (!requireRole(username, 'Admin')) return;
  bot.chat(`/tpa ${OWNER}`);
  safeReply(username, `Sent a /tpa request to ${OWNER}.`);
}

function cmdTpaHere(username, args) {
  if (!requireRole(username, 'Admin')) return;
  const target = args[0] || username;
  bot.chat(`/tpahere ${target}`);
  safeReply(username, `Sent a /tpahere request to ${target}.`);
}

function cmdSetHome(username, args) {
  if (!requireRole(username, 'Admin')) return;
  const homeName = args.join(' ');
  if (!homeName) return safeReply(username, `Usage: ${PREFIX}sethome <homename>`);
  bot.chat(`/sethome ${homeName}`);
  safeReply(username, `Ran /sethome ${homeName}.`);
}

function cmdDelHome(username, args) {
  if (!requireRole(username, 'Admin')) return;
  const homeName = args.join(' ');
  if (!homeName) return safeReply(username, `Usage: ${PREFIX}delhome <homename>`);
  bot.chat(`/delhome ${homeName}`);
  safeReply(username, `Ran /delhome ${homeName}.`);
}

function cmdSetRole(username, args) {
  if (!requireRole(username, 'Owner')) return;
  const targetUser = args[0];
  const role = args.slice(1).join(' ');
  if (!targetUser || !role) {
    return safeReply(username, `Usage: ${PREFIX}config setrole <player> <Admin|Mod|Default|custom role> (Owner is reserved)`);
  }
  try {
    roleManager.setRole(targetUser, role);
    safeReply(username, `Set ${targetUser}'s role to ${role}.`);
  } catch (err) {
    safeReply(username, err.message);
  }
}

function cmdListRoles(username) {
  if (!requireRole(username, 'Mod')) return;
  const list = roleManager.list();
  const lines = list.map(r => `${r.username}: ${r.role}`);
  for (const role of roleManager.listCustomRoles()) {
    const access = role.kits.length ? role.kits.join(',') : 'all kits';
    lines.push(`Role ${role.name} (level ${role.level}): ${access}`);
  }
  safeReply(username, lines.join('\n'));
}

function cmdReload(username) {
  if (!requireRole(username, 'Owner')) return;
  kitManager.reload();
  roleManager.reload();
  adManager.reload();
  thanksManager.reload();
  statsManager.reload();
  economyManager.reload();
  safeReply(username, 'Reloaded kits.txt, roles.txt, ads.txt, thanks.txt, stats.txt, and economy.txt from disk.');
}

// Runtime-adjustable settings, e.g. "*config amount 4" makes the bot withdraw
// 4 items per kit claim. Admin+ only. Changes are written back to config.json
// so they persist across restarts.
const CONFIG_SETTINGS = {
  amount: {
    key: 'kitWithdrawAmount',
    describe: 'items withdrawn per kit claim',
    parse: (v) => {
      const n = parseInt(v, 10);
      if (!Number.isInteger(n) || n < 1) throw new Error('amount must be a whole number of 1 or more.');
      return n;
    }
  },
  cooldown: {
    key: 'kitCooldownSeconds',
    describe: 'seconds between kit claims per player',
    parse: (v) => {
      const n = parseInt(v, 10);
      if (!Number.isInteger(n) || n < 0) throw new Error('cooldown must be a whole number of seconds (0 or more).');
      return n;
    }
  },
  radius: {
    key: 'kitTpaKillRadius',
    describe: 'blocks the player must be within before /kill fires',
    parse: (v) => {
      const n = parseInt(v, 10);
      if (!Number.isInteger(n) || n < 1) throw new Error('radius must be a whole number of blocks, 1 or more.');
      return n;
    }
  },
  globaldelay: {
    key: 'kitActionGlobalDelayMs',
    describe: 'ms between any two /tpa+/kill actions, server-wide',
    parse: (v) => {
      const n = parseInt(v, 10);
      if (!Number.isInteger(n) || n < 0) throw new Error('globaldelay must be a whole number of milliseconds.');
      return n;
    }
  },
  adsinterval: {
    key: 'adsIntervalMs',
    describe: 'ms between automatic advertisement messages',
    parse: (v) => {
      const n = parseInt(v, 10);
      if (!Number.isInteger(n) || n < 1000) throw new Error('adsinterval must be at least 1000ms.');
      return n;
    }
  },
  ads: {
    key: 'adsEnabled',
    describe: 'on/off - whether advertisements are posted',
    parse: (v) => {
      const lower = v.toLowerCase();
      if (lower === 'on' || lower === 'true') return true;
      if (lower === 'off' || lower === 'false') return false;
      throw new Error('ads must be set to "on" or "off".');
    }
  },
  thanks: {
    key: 'thanksEnabled',
    describe: 'on/off - whether a thank-you message is posted after each kit delivery',
    parse: (v) => {
      const lower = v.toLowerCase();
      if (lower === 'on' || lower === 'true') return true;
      if (lower === 'off' || lower === 'false') return false;
      throw new Error('thanks must be set to "on" or "off".');
    }
  },
  delivery: {
    key: 'kitDeliveryEnabled',
    describe: 'on/off - whether *kit actually fetches items',
    parse: (v) => {
      const lower = v.toLowerCase();
      if (lower === 'on' || lower === 'true') return true;
      if (lower === 'off' || lower === 'false') return false;
      throw new Error('delivery must be set to "on" or "off".');
    }
  },
  maintenance: {
    key: 'maintenanceMode',
    describe: 'on/off - when on, only Mod+ can use any bot command',
    parse: (v) => {
      const lower = v.toLowerCase();
      if (lower === 'on' || lower === 'true') return true;
      if (lower === 'off' || lower === 'false') return false;
      throw new Error('maintenance must be set to "on" or "off".');
    }
  }
};

function cmdConfig(username, args) {
  const sub = (args[0] || '').toLowerCase();
  const rest = args.slice(1);

  // --- Mod+ subcommands (checked before the general Admin+ gate) ---
  if (sub === 'ignore' || sub === 'unignore') {
    if (!requireRole(username, 'Mod')) return;
    return cmdConfigIgnore(username, sub, args[1]);
  }
  if (sub === 'roles' || sub === 'listroles') {
    if (!requireRole(username, 'Mod')) return;
    return cmdListRoles(username);
  }
  if (sub === 'feedbacklist') {
    if (!requireRole(username, 'Mod')) return;
    const limit = parseInt(rest[0], 10) || 5;
    const entries = feedbackManager.list(limit);
    if (entries.length === 0) return safeReply(username, 'No feedback recorded yet.');
    return safeReply(username, entries.join(' | '));
  }

  if (!requireRole(username, 'Admin')) return;

  // --- Admin+ subcommands ---
  if (sub === 'give') return cmdConfigGive(username, args);
  if (sub === 'setmp') return cmdConfigSetMp(username, args);
  if (sub === 'addmp') return cmdConfigAddMp(username, args);
  if (sub === 'delmp') return cmdConfigDelMp(username, args);
  if (sub === 'resetqueue') return cmdConfigResetQueue(username);
  if (sub === 'come') return cmdCome(username);
  if (sub === 'tpahere') return cmdTpaHere(username, rest);
  if (sub === 'sethome') return cmdSetHome(username, rest);
  if (sub === 'delhome') return cmdDelHome(username, rest);
  if (sub === 'kitset') return cmdKitSet(username, rest);
  if (sub === 'delkit') return cmdDelKit(username, rest);
  if (sub === 'broadcast') {
    const message = rest.join(' ');
    if (!message) return safeReply(username, `Usage: ${PREFIX}config broadcast <message>`);
    bot.chat(`[Announcement] ${message}`);
    return;
  }
  if (sub === 'friends') {
    return cmdConfigToggleDiscountList(username, 'friendUsers', args[1], `friend discount (${Math.round((config.friendDiscount ?? 0.15) * 100)}%)`, `${PREFIX}config friends <user>`);
  }
  if (sub === 'dev') {
    return cmdConfigToggleDiscountList(username, 'devUsers', args[1], `dev discount (${Math.round((config.devDiscount ?? 0.30) * 100)}%)`, `${PREFIX}config dev <user>`);
  }

  // --- Owner-only subcommands (still requires Admin+ above, plus this) ---
  if (sub === 'setrole') {
    if (!requireRole(username, 'Owner')) return;
    return cmdSetRole(username, rest);
  }
  if (sub === 'reload') {
    if (!requireRole(username, 'Owner')) return;
    return cmdReload(username);
  }
  if (sub === 'clearfeedback') {
    if (!requireRole(username, 'Owner')) return;
    feedbackManager.clear();
    return safeReply(username, 'feedback.txt has been cleared.');
  }

  const value = args[1];

  if (!sub || sub === 'help') {
    const helpPages = [
      `Usage: ${PREFIX}config <setting> <value> | ${PREFIX}config show`,
      `Settings: ${Object.keys(CONFIG_SETTINGS).join(', ')}`,
      `Mod+: ${PREFIX}config roles / ${PREFIX}config feedbacklist [count] / ${PREFIX}config ignore <user|others> / ${PREFIX}config unignore <user|others>`,
      `Admin+: ${PREFIX}config give <user> <kit> / ${PREFIX}config setmp|addmp|delmp <user|everyone> <amount> / ${PREFIX}config resetqueue (same as ${PREFIX}queue reset) / ` +
      `${PREFIX}config come / ${PREFIX}config tpahere [player] / ${PREFIX}config sethome|delhome <name> / ${PREFIX}config kitset <x> <y> <z> <kit> <cost> / ${PREFIX}config delkit <kit> / ${PREFIX}config broadcast <message>`,
      `Admin+: ${PREFIX}config friends <user> (toggle 15% discount) / ${PREFIX}config dev <user> (toggle 30% discount)`,
      `Owner: ${PREFIX}config setrole <user> <role> / ${PREFIX}config reload / ${PREFIX}config clearfeedback`,
      'Custom roles and kit access are configured in roles.txt; see its header for the @role format.'
    ];
    helpPages.forEach((page, index) => {
      setTimeout(() => safeReply(username, page), index * 2000);
    });
    return;
  }

  if (sub === 'show' || sub === 'list') {
    const lines = Object.entries(CONFIG_SETTINGS).map(([name, def]) => `${name}=${config[def.key]}`);
    return safeReply(username, lines.join('  '));
  }

  const def = CONFIG_SETTINGS[sub];
  if (!def) {
    return safeReply(username, `Unknown setting "${sub}". Try ${PREFIX}config help`);
  }

  if (value === undefined) {
    return safeReply(username, `${sub} (${def.describe}) is currently: ${config[def.key]}`);
  }

  try {
    const parsed = def.parse(value);
    config[def.key] = parsed;
    saveConfig();

    if (def.key === 'adsIntervalMs' || def.key === 'adsEnabled') {
      if (config.adsEnabled) startAdTimer();
      else stopAdTimer();
    }

    safeReply(username, `Set ${sub} to ${parsed}.`);
  } catch (err) {
    safeReply(username, err.message);
  }
}

// *config ignore <user>/others - Mod+.
// "others" blocks everyone who isn't Mod+ from using the bot at all.
// A specific username blocks just that player, regardless of their role
// (aside from the Owner, who can never be ignored).
function cmdConfigIgnore(username, sub, target) {
  if (!target) {
    return safeReply(username, `Usage: ${PREFIX}config ${sub} <user|others>`);
  }

  const isIgnoreAction = sub === 'ignore';
  const lowerTarget = target.toLowerCase();

  if (lowerTarget === 'others') {
    config.ignoreOthers = isIgnoreAction;
    saveConfig();
    return safeReply(
      username,
      isIgnoreAction
        ? 'Now ignoring everyone except Mod+.'
        : 'No longer ignoring other players.'
    );
  }

  if (lowerTarget === OWNER.toLowerCase()) {
    return safeReply(username, "Can't ignore the bot owner.");
  }

  config.ignoredUsers = config.ignoredUsers || [];
  if (isIgnoreAction) {
    if (!config.ignoredUsers.includes(lowerTarget)) {
      config.ignoredUsers.push(lowerTarget);
      saveConfig();
    }
    safeReply(username, `Now ignoring ${target}.`);
  } else {
    config.ignoredUsers = config.ignoredUsers.filter(u => u !== lowerTarget);
    saveConfig();
    safeReply(username, `No longer ignoring ${target}.`);
  }
}

// *config give <user> <kit> - Admin+. Jumps the kit straight to the front of
// the queue (it still goes through the same queue system - it's just
// inserted ahead of everyone else instead of at the back) and delivers it
// to the specified user, ignoring their normal per-player cooldown.
function cmdConfigGive(username, args) {
  const targetUser = args[1];
  const kitName = args.slice(2).join(' ');

  if (!targetUser || !kitName) {
    return safeReply(username, `Usage: ${PREFIX}config give <user> <kit>`);
  }

  const kit = kitManager.getKit(kitName);
  if (!kit) {
    return safeReply(username, `Kit "${kitName}" does not exist.`);
  }
  if (!config.kitDeliveryEnabled) {
    return safeReply(username, 'Kit delivery is currently disabled.');
  }

  enqueueKitRequest(targetUser, kit.name, async () => {
    safeReply(targetUser, `${username} is giving you kit "${kit.name}"...`);
    const result = await collectKitItem(kit);

    if (!result.success) {
      const reasonMsg =
        result.reason === 'no-chest' ? `couldn't find a chest for kit "${kit.name}".` :
        result.reason === 'empty' ? `the chest for kit "${kit.name}" was empty.` :
        `couldn't reach kit "${kit.name}" right now.`;
      safeReply(targetUser, `Sorry, I ${reasonMsg}`);
      safeReply(username, `Failed to give ${targetUser} kit "${kit.name}" - I ${reasonMsg}`);
      return;
    }

    safeReply(targetUser, `Got kit "${kit.name}"! Come stand near me - I'll drop it once teleportation finishes.`);
    await triggerTpaKill(targetUser);
  }, true);

  safeReply(username, `Queued kit "${kit.name}" for ${targetUser} - jumping the line, skipping the queue.`);
}

// Resolves a *config setmp/delmp target: either a single username, or the
// special keyword "everyone", which applies to every player currently
// online (excluding the bot itself).
function resolveMpTargets(target) {
  if (target.toLowerCase() === 'everyone') {
    return Object.keys(bot.players).filter(name => name.toLowerCase() !== bot.username.toLowerCase());
  }
  return [target];
}

// *config setmp <user|everyone> <amount> - Admin+. Sets balance directly.
function cmdConfigSetMp(username, args) {
  const target = args[1];
  const amount = parseInt(args[2], 10);
  if (!target || !Number.isInteger(amount) || amount < 0) {
    return safeReply(username, `Usage: ${PREFIX}config setmp <user|everyone> <amount>`);
  }
  const targets = resolveMpTargets(target);
  if (targets.length === 0) {
    return safeReply(username, 'No online players to apply that to.');
  }
  targets.forEach(t => economyManager.setBalance(t, amount));
  safeReply(
    username,
    target.toLowerCase() === 'everyone'
      ? `Set ${targets.length} online player(s) balance to ${amount} ${CURRENCY}.`
      : `Set ${target}'s balance to ${amount} ${CURRENCY}.`
  );
}

// *config addmp <user|everyone> <amount> - Admin+. Adds to a player's
// balance (as opposed to setmp, which sets it directly).
function cmdConfigAddMp(username, args) {
  const target = args[1];
  const amount = parseInt(args[2], 10);
  if (!target || !Number.isInteger(amount) || amount <= 0) {
    return safeReply(username, `Usage: ${PREFIX}config addmp <user|everyone> <amount>`);
  }
  const targets = resolveMpTargets(target);
  if (targets.length === 0) {
    return safeReply(username, 'No online players to apply that to.');
  }
  targets.forEach(t => economyManager.addBalance(t, amount));
  safeReply(
    username,
    target.toLowerCase() === 'everyone'
      ? `Added ${amount} ${CURRENCY} to ${targets.length} online player(s).`
      : `Added ${amount} ${CURRENCY} to ${target}. New balance: ${economyManager.getBalance(target)}.`
  );
}

// *config delmp <user|everyone> <amount> - Admin+. Subtracts an amount from
// a player's balance (clamped at 0, never goes negative).
function cmdConfigDelMp(username, args) {
  const target = args[1];
  const amount = parseInt(args[2], 10);
  if (!target || !Number.isInteger(amount) || amount <= 0) {
    return safeReply(username, `Usage: ${PREFIX}config delmp <user|everyone> <amount>`);
  }
  const targets = resolveMpTargets(target);
  if (targets.length === 0) {
    return safeReply(username, 'No online players to apply that to.');
  }
  targets.forEach(t => economyManager.subtractBalance(t, amount));
  safeReply(
    username,
    target.toLowerCase() === 'everyone'
      ? `Removed ${amount} ${CURRENCY} from ${targets.length} online player(s).`
      : `Removed ${amount} ${CURRENCY} from ${target}. New balance: ${economyManager.getBalance(target)}.`
  );
}

// *config resetqueue - Admin+. Clears everyone waiting in the kit queue.
// Whoever is currently being served (mid pathfind/tpa/kill) is NOT
// interrupted - only the pending, not-yet-started entries are dropped.
function cmdConfigResetQueue(username) {
  const cleared = kitQueue.length;
  kitQueue.length = 0;
  const stillServing = currentKitJob ? ` (${currentKitJob.username}'s in-progress kit will still finish)` : '';
  safeReply(username, `Cleared ${cleared} pending kit request(s) from the queue.${stillServing}`);
}

// Shared toggle logic for *config friends/*config dev - calling it again on
// the same user removes them from the list (so one command handles both
// adding and removing the discount).
function cmdConfigToggleDiscountList(username, key, target, label, usage) {
  if (!target) {
    return safeReply(username, `Usage: ${usage}`);
  }
  config[key] = config[key] || [];
  const lower = target.toLowerCase();
  const idx = config[key].findIndex(u => u.toLowerCase() === lower);
  if (idx >= 0) {
    config[key].splice(idx, 1);
    saveConfig();
    return safeReply(username, `Removed ${target} from ${label}.`);
  }
  config[key].push(target);
  saveConfig();
  safeReply(username, `Added ${target} to ${label}.`);
}

// ---------- console input -> in-game chat ----------
// Type anything into the terminal running this bot and press Enter -
// it will be sent as a public chat message from the bot's account.
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  if (!bot || !bot.entity) {
    console.log('[CenaAirlines] Bot is not connected yet, message not sent.');
    return;
  }
  bot.chat(text);
  console.log(`[CONSOLE] Sent to chat: ${text}`);
});

// ---------- start ----------

createBot();
