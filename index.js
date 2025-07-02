// index.js - All-in-one Discord Music Bot
require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection,
} = require("@discordjs/voice");
const play = require("play-dl");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const prefix = "thh!";
const queueMap = new Map(); // guildId -> { queue, player, connection, ... }

client.once("ready", () => console.log(`✅ Logged in as ${client.user.tag}`));

client.on("messageCreate", async (message) => {
  if (!message.content.startsWith(prefix) || message.author.bot) return;
  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  const guildId = message.guild.id;
  const userVC = message.member.voice.channel;

  if (!queueMap.has(guildId)) {
    queueMap.set(guildId, {
      queue: [],
      player: createAudioPlayer(),
      connection: null,
      currentChannelId: null,
      volume: 1,
      loopMode: "none", // none, song, queue
      lastSong: null,
    });
  }

  const data = queueMap.get(guildId);

  if ([ "play", "pause", "resume", "skip", "loop", "volume" ].includes(command) && !userVC)
    return message.reply("🔇 You must be in a voice channel.");
  if (data.connection && data.currentChannelId && userVC && userVC.id !== data.currentChannelId)
    return message.reply("❌ Bot is already active in another voice channel.");

  // COMMANDS
  if (command === "play") {
    const query = args.join(" ");
    if (!query) return message.reply("❗ Provide a song name or URL.");

    const result = await play.search(query, { limit: 1 });
    if (!result.length) return message.reply("❌ No results found.");

    const song = result[0];
    data.queue.push(song);
    message.channel.send(`🎵 Added: **${song.title}**`);

    if (!data.connection) {
      data.connection = joinVoiceChannel({
        channelId: userVC.id,
        guildId: guildId,
        adapterCreator: message.guild.voiceAdapterCreator,
      });
      data.currentChannelId = userVC.id;
      data.connection.subscribe(data.player);
      playNext(message, guildId);
    }
  }

  else if (command === "pause") {
    data.player.pause();
    message.channel.send("⏸️ Paused.");
  }

  else if (command === "resume") {
    data.player.unpause();
    message.channel.send("▶️ Resumed.");
  }

  else if (command === "skip") {
    message.channel.send("⏭️ Skipping...");
    playNext(message, guildId);
  }

  else if (command === "leave") {
    cleanup(guildId);
    message.channel.send("👋 Left VC and cleared queue.");
  }

  else if (command === "help") {
    message.channel.send(`🎧 **Music Bot Commands**

\`\`\`
thh!play <song>        - Play or queue a song
thh!pause              - Pause playback
thh!resume             - Resume playback
thh!skip               - Skip current song
thh!queue              - Show current queue
thh!queue shuffle      - Shuffle the queue
thh!volume <0-100>     - Set volume level
thh!loop               - Toggle loop mode (none → song → queue)
thh!leave              - Leave voice channel
thh!help               - Show help message
\`\`\``);
  }

  else if (command === "queue") {
    if (args[0] === "shuffle") {
      for (let i = data.queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [data.queue[i], data.queue[j]] = [data.queue[j], data.queue[i]];
      }
      return message.channel.send("🔀 Queue shuffled!");
    }
    if (!data.queue.length) return message.channel.send("📭 The queue is empty.");
    const list = data.queue.map((s, i) => `${i + 1}. ${s.title}`).join("\n");
    message.channel.send(`🎶 **Queue:**\n\n\`\`\`\n${list}\n\`\`\``);
  }

  else if (command === "volume") {
    const level = parseInt(args[0]);
    if (isNaN(level) || level < 0 || level > 100)
      return message.reply("❗ Volume must be between 0-100.");
    data.volume = level / 100;
    message.channel.send(`🔊 Volume set to ${level}%`);
  }

  else if (command === "loop") {
    if (data.loopMode === "none") data.loopMode = "song";
    else if (data.loopMode === "song") data.loopMode = "queue";
    else data.loopMode = "none";
    message.channel.send(`🔁 Loop mode: **${data.loopMode}**`);
  }
});

async function playNext(message, guildId) {
  const data = queueMap.get(guildId);
  let next = data.queue.shift();

  if (data.loopMode === "song" && data.lastSong) {
    next = data.lastSong;
  } else if (data.loopMode === "queue" && data.lastSong) {
    data.queue.push(data.lastSong);
  }

  if (!next) {
    try {
      const related = await play.related(data.lastSong?.url);
      if (related?.length) {
        const suggestion = related[0];
        data.queue.push(suggestion);
        message.channel.send(`🎵 Auto-playing suggestion: **${suggestion.title}**`);
        return playNext(message, guildId);
      }
    } catch (e) {}
    cleanup(guildId);
    message.channel.send("✅ Queue ended. Leaving VC.");
    return;
  }

  try {
    const stream = await play.stream(next.url, { quality: 2 });
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
      inlineVolume: true,
    });
    resource.volume.setVolume(data.volume || 1);

    data.lastSong = next;
    data.player.play(resource);
    message.channel.send(`🎶 Now playing: **${next.title}**`);

    data.player.once(AudioPlayerStatus.Idle, () => playNext(message, guildId));
    data.player.once("error", (err) => {
      console.error("Playback error:", err);
      message.channel.send("⚠️ Error playing song. Skipping...");
      playNext(message, guildId);
    });
  } catch (err) {
    console.error("Stream error:", err);
    message.channel.send("❌ Error streaming song. Skipping...");
    playNext(message, guildId);
  }
}

function cleanup(guildId) {
  const data = queueMap.get(guildId);
  if (data?.player) data.player.stop();
  if (data?.connection) data.connection.destroy();
  queueMap.delete(guildId);
}

client.login(process.env.TOKEN);
