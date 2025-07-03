require("dotenv").config();
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { Manager } = require("erela.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const prefix = "thh!";
const guildVoiceState = new Map();

client.manager = new Manager({
  nodes: [
    {
      host: process.env.LAVALINK_HOST,
      port: parseInt(process.env.LAVALINK_PORT),
      password: process.env.LAVALINK_PASSWORD,
      secure: process.env.LAVALINK_SECURE === "true",
    },
  ],
  send(id, payload) {
    const guild = client.guilds.cache.get(id);
    if (guild) guild.shard.send(payload);
  },
});

client.on("ready", () => {
  console.log(`${client.user.tag} is online!`);
  client.manager.init(client.user.id);
});

client.on("raw", d => client.manager.updateVoiceState(d));

client.on("messageCreate", async message => {
  if (!message.guild || message.author.bot || !message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const cmd = args.shift().toLowerCase();

  const { channel } = message.member.voice;
  const player = client.manager.players.get(message.guild.id);

  if (["play", "pause", "resume", "skip", "leave"].includes(cmd) && !channel)
    return message.reply("You must be in a voice channel first.");

  if (channel) {
    const existing = guildVoiceState.get(message.guild.id);
    if (existing && existing !== channel.id)
      return message.reply("I’m already playing in another voice channel.");
  }

  switch (cmd) {
    case "play": {
      if (!args[0]) return message.reply("Please provide a song name or link.");
      let player = client.manager.create({
        guild: message.guild.id,
        voiceChannel: channel.id,
        textChannel: message.channel.id,
        selfDeafen: true,
      });
      guildVoiceState.set(message.guild.id, channel.id);

      if (player.state !== "CONNECTED") player.connect();

      let res = await client.manager.search(args.join(" "), message.author);
      if (res.loadType === "LOAD_FAILED" || !res.tracks.length)
        return message.reply("No results found.");

      player.queue.add(res.tracks[0]);
      message.reply(`Enqueued **${res.tracks[0].title}**`);
      if (!player.playing) player.play();
      break;
    }

    case "pause":
      if (!player) return message.reply("Nothing is playing.");
      player.pause(true);
      message.reply("⏸ Paused.");
      break;

    case "resume":
      if (!player) return message.reply("Nothing is playing.");
      player.pause(false);
      message.reply("▶️ Resumed.");
      break;

    case "skip":
      if (!player || !player.queue.current) return message.reply("Nothing to skip.");
      player.stop();
      message.reply("⏭ Skipped.");
      break;

    case "leave":
      if (!player) return message.reply("I'm not in a voice channel.");
      player.destroy();
      guildVoiceState.delete(message.guild.id);
      message.reply("👋 Left the voice channel and cleared the queue.");
      break;

    case "queue":
      if (!player || !player.queue.length) return message.reply("The queue is empty.");
      const queue = player.queue.map((t, i) => `${i + 1}. ${t.title}`).join("\n");
      message.reply(`**Current Queue:**\n${queue}`);
      break;

    case "help":
      message.reply(`
🎵 **Available Commands**:
\`${prefix}play <url|query>\` - Play a song
\`${prefix}pause\` - Pause playback
\`${prefix}resume\` - Resume playback
\`${prefix}skip\` - Skip current song
\`${prefix}queue\` - Show song queue
\`${prefix}leave\` - Leave voice channel and clear queue
      `);
      break;
  }
});
