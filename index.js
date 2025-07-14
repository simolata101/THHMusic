// index.js
import {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    PermissionsBitField,
    AttachmentBuilder 
} from 'discord.js';
import {
    createClient
} from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';
import cron from 'node-cron';
import { createStatusCard } from './utils/createStatusCard.js';
dotenv.config();

const settingsConfig = JSON.parse(fs.readFileSync('./config/settings.json', 'utf8'));
const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const activeVoiceUsers = new Map(); // user_id => { guild_id, channel_id }

const bot = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates 
    ]
});

// Slash Command Setup
bot.on('ready', async () => {
    const cmds = [
        new SlashCommandBuilder().setName('showstatus').setDescription('Show your stats')
        .addUserOption(opt => opt.setName('user').setDescription('User to view')),
        new SlashCommandBuilder().setName('help').setDescription('Show help command'),
        new SlashCommandBuilder().setName('leaderboard').setDescription('Show top 10 users'),
        new SlashCommandBuilder().setName('setmessagepoints')
        .addIntegerOption(opt => opt.setName('amount').setDescription('XP per message').setRequired(true))
        .setDescription('Set XP gain per message (Admin)'),
        new SlashCommandBuilder().setName('allowchannel')
        .addChannelOption(opt => opt.setName('channel').setDescription('Channel to allow XP in').setRequired(true))
        .setDescription('Allow XP in this channel (Admin)'),
        new SlashCommandBuilder().setName('removechannel')
        .addChannelOption(opt => opt.setName('channel').setDescription('Remove channel from XP gain').setRequired(true))
        .setDescription('Disallow XP in this channel (Admin)'),
        new SlashCommandBuilder().setName('removerole')
        .addRoleOption(opt => opt.setName('role').setDescription('Role to remove').setRequired(true))
        .setDescription('Remove an auto-assigned role (Admin)'),
        new SlashCommandBuilder().setName('setrole')
        .addIntegerOption(opt => opt.setName('min').setDescription('Min level').setRequired(true))
        .addIntegerOption(opt => opt.setName('max').setDescription('Max level').setRequired(true))
        .addRoleOption(opt => opt.setName('role').setDescription('Role to assign').setRequired(true))
        .setDescription('Set auto role by level range (Admin)'),
        new SlashCommandBuilder()
        .setName('setvcpoints')
        .addIntegerOption(opt => opt.setName('amount').setDescription('XP per minute in voice').setRequired(true))
        .setDescription('Set XP gain per minute for voice channels (Admin)'),
        new SlashCommandBuilder().setName('setstreakmessages')
        .addIntegerOption(opt =>
            opt.setName('amount')
            .setDescription('Messages per day to maintain streak')
            .setRequired(true))
        .setDescription('Set required messages per day for streaks (Admin)'),
        new SlashCommandBuilder().setName('setlevelupchannel')
        .addChannelOption(opt =>
            opt.setName('channel')
            .setDescription('Channel for level-up and role messages')
            .setRequired(true)
        )
        .setDescription('Set the channel for level-up and role notifications (Admin)'),
        new SlashCommandBuilder().setName('setboostermultiplier')
        .addNumberOption(opt => opt.setName('amount').setDescription('XP multiplier for boosters').setRequired(true))
        .setDescription('Set XP multiplier for server boosters (Admin)')
    ].map(c => c.toJSON());

    await bot.application.commands.set(cmds);
    console.log('✅ Bot is ready');
});

// Slash Command Handler
bot.on('interactionCreate', async inter => {
    if (!inter.isChatInputCommand()) return;
    const uid = inter.user.id;
    const gid = inter.guildId;
    const now = new Date().toISOString().split('T')[0];

    // Ensure user exists
    let {
        data: userData
    } = await supa.from('users').select().eq('user_id', uid).single();
    if (!userData) {
        const res = await supa.from('users').insert({
            user_id: uid,
            coins: 0,
            xp: 0,
            lvl: 1,
            streak: 1,
            last_active: now
        }).select().single();
        userData = res.data;
    } else {
        const yesterday = new Date(Date.now() - 86400e3).toISOString().split('T')[0];
        const newStreak = userData.last_active === yesterday ? userData.streak + 1 : (userData.last_active === now ? userData.streak : 1);
        await supa.from('users').update({
            streak: newStreak,
            last_active: now
        }).eq('user_id', uid);
        userData.streak = newStreak;
    }

    if (inter.commandName === 'showstatus') {
    const target = inter.options.getUser('user') || inter.user;
    const { data: targetData } = await supa.from('users').select().eq('user_id', target.id).single();

    if (!targetData) return inter.reply(`❌ No data found for <@${target.id}>`);

    const member = await inter.guild.members.fetch(target.id).catch(() => null);
    const isBooster = member?.premiumSince !== null;
    const { data: guildSettings } = await supa.from('settings').select().eq('guild_id', inter.guildId).single();
    const multiplier = isBooster ? (guildSettings?.booster_multiplier ?? 1.5) : 1;

    const buffer = await createStatusCard({
        username: target.username,
        xp: targetData.xp,
        lvl: targetData.lvl,
        streak: targetData.streak,
        isBooster: isBooster,
        multiplier: multiplier
    }, target.displayAvatarURL({ extension: 'png', size: 256 }));

    const attachment = new AttachmentBuilder(buffer, { name: 'status.png' });
    return inter.reply({
        content: `🌟 Status for <@${target.id}>`,
        files: [attachment]
    });
    }

      if (inter.commandName === 'setvcpoints') {
          if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return inter.reply('❌ Admin only.');
          }
        
          const amt = inter.options.getInteger('amount');
          await supa.from('settings').upsert({ guild_id: gid, vc_points: amt });
    
      return inter.reply(`🔊 Voice XP set to **${amt} XP/minute**.`);
    }


    if (inter.commandName === 'setstreakmessages') {
        if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return inter.reply('❌ Admin only.');
        }

        const amount = inter.options.getInteger('amount');
        await supa.from('streak_config').upsert({
            guild_id: gid,
            required_message: amount
        });

        return inter.reply(`📈 Required daily messages for streak set to **${amount}**.`);
    }

    if (inter.commandName === 'setboostermultiplier') {
        if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return inter.reply('❌ Admin only.');
        }
        
        const multiplier = inter.options.getNumber('amount');
            if (multiplier < 1) {
                return inter.reply('❌ Multiplier must be at least 1.0');
            }
        
        await supa.from('settings').upsert({ 
            guild_id: gid, 
            booster_multiplier: multiplier 
        });
        
        return inter.reply(`✨ Booster XP multiplier set to **${multiplier}x**`);
    }

    if (inter.commandName === 'help') {
        const {
            data: setting
        } = await supa.from('settings').select().eq('guild_id', gid).single();
        const {
            data: streak_config
        } = await supa.from('streak_config').select().eq('guild_id', gid).single();
        const {
            data: allowed
        } = await supa.from('allowed_channels').select().eq('guild_id', gid);
        const {
            data: decay
        } = await supa.from('decay_config').select().eq('guild_id', gid).single();
        const {
            data: levelRoles
        } = await supa.from('level_roles').select().eq('guild_id', gid);
        const roleList = levelRoles?.map(r => {
            const roleObj = inter.guild.roles.cache.get(r.role_id);
            return roleObj ? `• ${roleObj.name}: Levels ${r.min_level}–${r.max_level}` : null;
        }).filter(Boolean).join('\n') || '*None set*';
        const levelUpChannel = setting?.levelup_channel ? `<#${setting.levelup_channel}>` : '*Not set*';

        const allowedList = allowed?.map(a => `<#${a.channel_id}>`).join(', ') || '*None*';
        const msgPoints = setting?.message_points ?? process.env.DEFAULT_MESSAGE_POINTS ?? settingsConfig.default_message_points;
        const decayInfo = decay ? `🕒 XP decays after ${decay.days_before_decay} days by ${decay.percentage_decay * 100}%` : '🕒 No decay configured.';
        const boosterMultiplier = setting?.booster_multiplier ?? 1.5;

        return inter.reply({
            embeds: [{
                title: '📘 Help Menu',
                description: `**/showstatus [user]** – View XP, level, streak  
      **/leaderboard** – Show top 10 users
      **/setrole [min] [max] [role]** – Auto-assign role
      **/removerole [role]** – Remove auto role
      **/setmessagepoints [amount]** – Set XP gain per message
      **/allowchannel [#channel]** – Allow XP in channel
      **/removechannel [#channel]** – Block XP in channel
      **/setlevelupchannel [#channel]** – Set level-up message channel
      **/setstreakmessages [amount]** – Set required daily messages for streak (Admin)
      **/setvcpoints [amount]** – Set XP per minute in voice chat
      
      📊 XP per message: **${msgPoints}**  
      📺 Allowed XP channels: ${allowedList}  
      ${decayInfo}  
      🔥 Streak requirement: ${streak_config?.required_message ?? 'Not set'} message(s) per day
      🔊 VC XP per minute: **${setting?.vc_points ?? 'Not set'}**
      🎖️ **Level Roles:**  
      ${roleList}
      📢 Level-up messages: ${levelUpChannel}
      ✨ Booster XP multiplier: **${boosterMultiplier}x**\n`,
                color: 0x7a5cfa
            }]
        });
    }

    if (inter.commandName === 'setmessagepoints') {
        if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Admin only.');
        const amt = inter.options.getInteger('amount');
        await supa.from('settings').upsert({
            guild_id: gid,
            message_points: amt
        });
        return inter.reply(`✅ XP per message set to **${amt}**.`);
    }

    if (inter.commandName === 'allowchannel') {
        if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Admin only.');
        const channel = inter.options.getChannel('channel');
        if (!channel.isTextBased()) return inter.reply('❌ Please select a text-based channel.');
        await supa.from('allowed_channels').upsert({
            guild_id: gid,
            channel_id: channel.id
        });
        return inter.reply(`✅ XP now allowed in <#${channel.id}>`);
    }

    if (inter.commandName === 'removechannel') {
        if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Admin only.');
        const channel = inter.options.getChannel('channel');
        await supa.from('allowed_channels').delete().eq('guild_id', gid).eq('channel_id', channel.id);
        return inter.reply(`🚫 XP disabled in <#${channel.id}>`);
    }

    if (inter.commandName === 'setlevelupchannel') {
        if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return inter.reply('❌ Admin only.');
        }

        const channel = inter.options.getChannel('channel');
        if (!channel.isTextBased()) {
            return inter.reply('❌ Please select a text-based channel.');
        }

        await supa.from('settings').upsert({
            guild_id: gid,
            levelup_channel: channel.id
        });
        return inter.reply(`📢 Level-up messages will now be sent in <#${channel.id}>.`);
    }

    if (inter.commandName === 'setrole') {
        if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Admin only.');
        const min = inter.options.getInteger('min');
        const max = inter.options.getInteger('max');
        const role = inter.options.getRole('role');

        const {
            data: existing
        } = await supa.from('level_roles').select().eq('guild_id', gid);
        const overlapping = existing?.some(r =>
            (min >= r.min_level && min <= r.max_level) ||
            (max >= r.min_level && max <= r.max_level)
        );
        if (overlapping) return inter.reply('❌ Overlapping level range exists.');

        await supa.from('level_roles').insert({
            guild_id: gid,
            min_level: min,
            max_level: max,
            role_id: role.id
        });
        return inter.reply(`🎖️ Role **${role.name}** will now be assigned to levels ${min}–${max}`);
    }

    if (inter.commandName === 'removerole') {
        if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return inter.reply('❌ Admin only.');
        }

        const role = inter.options.getRole('role');
        const {
            data: existing
        } = await supa.from('level_roles').select().eq('guild_id', gid).eq('role_id', role.id).single();

        if (!existing) {
            return inter.reply('❌ That role is not assigned through level roles.');
        }

        await supa.from('level_roles').delete().eq('guild_id', gid).eq('role_id', role.id);
        return inter.reply(`🗑️ Removed **${role.name}** from level role assignments.`);
    }

    if (inter.commandName === 'leaderboard') {
        const {
            data: top
        } = await supa.from('users').select().order('xp', {
            ascending: false
        }).limit(10);
        const members = await inter.guild.members.fetch();
        const list = top.map((u, i) => `**${i + 1}.** ${members.get(u.user_id)?.displayName || `<@${u.user_id}>`} – ${u.xp} XP`).join('\n');

        return inter.reply({
            embeds: [{
                title: '🏆 Top 10 Leaderboard',
                description: list,
                color: 0xffcc00
            }]
        });
    }
});

// Message XP Handler
bot.on('messageCreate', async msg => {
    if (msg.author.bot || !msg.guild) return;
    const uid = msg.author.id;
    const gid = msg.guild.id;
    const cid = msg.channel.id;
    const now = new Date().toISOString().split('T')[0];

    const {
        data: allowed
    } = await supa.from('allowed_channels').select().eq('guild_id', gid);
    if (!allowed?.some(c => c.channel_id === cid)) return;

    const {
        data: setting
    } = await supa.from('settings').select().eq('guild_id', gid).single();
    const xpGain = setting?.message_points ?? parseInt(process.env.DEFAULT_MESSAGE_POINTS) ?? settingsConfig.default_message_points;

    let {
        data: user
    } = await supa.from('users').select().eq('user_id', uid).single();
    if (!user) {
        const res = await supa.from('users').insert({
            user_id: uid,
            xp: 0,
            lvl: 1,
            coins: 0,
            streak: 1,
            last_active: now
        }).select().single();
        user = res.data;
    }

    const newXp = user.xp + xpGain;
    const newLvl = Math.floor(Math.sqrt(newXp / 10)) + 1;
    const leveledUp = newLvl > user.lvl;

    await supa.from('users').update({
        xp: newXp,
        lvl: newLvl,
        last_active: now
    }).eq('user_id', uid);

    if (leveledUp) {
        const {
            data: setting
        } = await supa.from('settings').select().eq('guild_id', gid).single();
        const {
            data: roles
        } = await supa.from('level_roles').select().eq('guild_id', gid);

        const announceChannelId = setting?.levelup_channel;
        const announceChannel = announceChannelId ? msg.guild.channels.cache.get(announceChannelId) : msg.channel;

        announceChannel?.isTextBased() && announceChannel.send(`🎉 <@${uid}> leveled up to **${newLvl}**!`);

        const member = await msg.guild.members.fetch(uid);
        const matchedRoles = roles?.filter(r => newLvl >= r.min_level && newLvl <= r.max_level) || [];

        for (const r of matchedRoles) {
            const role = msg.guild.roles.cache.get(r.role_id);
            if (role && !member.roles.cache.has(role.id)) {
                await member.roles.add(role);
                msg.channel.send(`🛡️ <@${uid}> received role **${role.name}**!`);
            }
        }
    }

    // direct query logic
    const { data: existing } = await supa
    .from('message_log')
    .select('count')
    .eq('user_id', uid)
    .eq('guild_id', gid)
    .eq('date', now)
    .single();

    if (existing) {
        await supa.from('message_log')
            .update({ count: existing.count + 1 })
            .eq('user_id', uid)
            .eq('guild_id', gid)
            .eq('date', now);
    } else {
        await supa.from('message_log')
            .insert({ user_id: uid, guild_id: gid, date: now, count: 1 });
    }

    const isBooster = msg.member.premiumSince !== null;
    if (isBooster) {
        await supa.from('users').update({ is_booster: true }).eq('user_id', uid);
    }

    const multiplier = isBooster ? (setting?.booster_multiplier ?? 1.5) : 1;

    const xpGain = Math.floor((setting?.message_points ?? settingsConfig.default_message_points) * multiplier);

});


bot.on('voiceStateUpdate', (oldState, newState) => {
  const uid = newState.id;
  const guild_id = newState.guild.id;
  const member = newState.member;

  const inVoice = newState.channelId !== null;
  const selfMuted = newState.selfMute;
  const selfDeafened = newState.selfDeaf;

  const eligible = inVoice && !selfMuted && !selfDeafened;

  if (eligible) {
    activeVoiceUsers.set(uid, { guild_id, channel_id: newState.channelId });
  } else {
    activeVoiceUsers.delete(uid);
  }
});




// XP Decay Job
cron.schedule('0 4 * * *', async () => {
    const today = new Date();
    const {
        data: configs
    } = await supa.from('decay_config').select();
    const {
        data: users
    } = await supa.from('users').select();

    for (const g of configs) {
        const cutoff = new Date(today - g.days_before_decay * 86400e3).toISOString().split('T')[0];
        for (const u of users) {
            if (u.last_active < cutoff) {
                const newXp = Math.floor(u.xp * (1 - g.percentage_decay));
                const newLvl = Math.floor(Math.sqrt(newXp / 10)) + 1;
                await supa.from('users').update({
                    xp: newXp,
                    lvl: newLvl
                }).eq('user_id', u.user_id);
            }
        }
    }
});

// Streak Update Job – 5:00 AM
cron.schedule('0 5 * * *', async () => {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const yesterday = new Date(today.getTime() - 86400e3).toISOString().split('T')[0];

     for (const user of users) {
        // Check if user is still a booster
        const guild = bot.guilds.cache.get(guild_id);
        const member = await guild.members.fetch(user.user_id).catch(() => null);
        const isBooster = member?.premiumSince !== null;
        await supa.from('users').update({ is_booster: isBooster }).eq('user_id', user.user_id);
        
        // ... rest of streak logic ...
    }

    const {
        data: configs
    } = await supa.from('streak_config').select();
    if (!configs) return;

    for (const config of configs) {
        const {
            guild_id,
            required_message
        } = config;

        const {
            data: users
        } = await supa.from('users').select();
        if (!users) continue;

        for (const user of users) {
            // Get yesterday's message count
            const {
                data: msgLog
            } = await supa.from('message_log')
                .select('count')
                .eq('guild_id', guild_id)
                .eq('user_id', user.user_id)
                .eq('date', yesterday)
                .single();

            const messagesYesterday = msgLog?.count ?? 0;
            let newStreak;

            if (user.last_active === todayStr) {
                newStreak = user.streak; // Already active today
            } else if (messagesYesterday >= required_message) {
                newStreak = user.streak + 1;
            } else {
                newStreak = 1;
            }

            await supa.from('users')
                .update({
                    streak: newStreak
                })
                .eq('user_id', user.user_id);
        }
    }

    console.log('✅ Streaks updated at 5:00 AM based on message count');
});

cron.schedule('* * * * *', async () => {
    const now = new Date().toISOString().split('T')[0];

    for (const [uid, session] of activeVoiceUsers.entries()) {
        const {
            guild_id,
            channel_id
        } = session;

        const {
            data: setting
        } = await supa.from('settings').select().eq('guild_id', guild_id).single();
        const xpGain = setting?.vc_points ?? parseInt(process.env.DEFAULT_VC_POINTS) ?? 2;

        let {
            data: user
        } = await supa.from('users').select().eq('user_id', uid).single();
        if (!user) {
            const res = await supa.from('users').insert({
                user_id: uid,
                xp: 0,
                lvl: 1,
                coins: 0,
                streak: 1,
                last_active: now
            }).select().single();
            user = res.data;
        }

        const newXp = user.xp + xpGain;
        const newLvl = Math.floor(Math.sqrt(newXp / 10)) + 1;
        const leveledUp = newLvl > user.lvl;

        await supa.from('users').update({
            xp: newXp,
            lvl: newLvl,
            last_active: now
        }).eq('user_id', uid);

        if (leveledUp) {
            const {
                data: roles
            } = await supa.from('level_roles').select().eq('guild_id', guild_id);
            const announceChannelId = setting?.levelup_channel;
            const guild = bot.guilds.cache.get(guild_id);
            const announceChannel = announceChannelId ? guild.channels.cache.get(announceChannelId) : null;
            announceChannel?.isTextBased() && announceChannel.send(`🔊 <@${uid}> leveled up to **${newLvl}** from voice chat!`);

            const member = await guild.members.fetch(uid);
            const matchedRoles = roles?.filter(r => newLvl >= r.min_level && newLvl <= r.max_level) || [];

            for (const r of matchedRoles) {
                const role = guild.roles.cache.get(r.role_id);
                if (role && !member.roles.cache.has(role.id)) {
                    await member.roles.add(role);
                    announceChannel?.send(`🛡️ <@${uid}> received role **${role.name}**!`);
                }
            }
        }

        // Check if user is a booster
        const guild = bot.guilds.cache.get(guild_id);
        const member = await guild.members.fetch(uid).catch(() => null);
        const isBooster = member?.premiumSince !== null;
        if (isBooster) {
            await supa.from('users').update({ is_booster: true }).eq('user_id', uid);
        }

        // Get multiplier from settings
        const multiplier = isBooster ? (setting?.booster_multiplier ?? 1.5) : 1;
        const xpGain = Math.floor((setting?.vc_points ?? 2) * multiplier);
    }
});

bot.login(process.env.DISCORD_TOKEN);
