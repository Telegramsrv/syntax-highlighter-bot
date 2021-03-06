/* eslint-disable no-console */
import Knex from 'knex'
import https from 'https'
import express from 'express'
import webshot from 'webshot'
import Telegraf from 'telegraf'
import Markup from 'telegraf/markup'

import dbConfig from './config/knexfile'
import { messages, themes, langs } from './config/messages'
import { tlsOptions, webshotOptions, url, _env } from './config/config'
import {
  getPath,
  getTempPath,
  getThemeSlug,
  getThemeName,
  getImageFileName,
  isExisted,
  getFileURL,
  getPhotoData,
  isPrivateChat,
  chatUser,
  themesKeyboard,
  replyWithPhoto,
  onError,
} from './support/utils'

import UserModel from './model/User/user-model'
import ChatModel from './model/Chat/chat-model'
import ChunkModel from './model/Chunk/chunk-model'


const knex = Knex(dbConfig[_env.NODE_ENV])

ChatModel.knex(knex)
UserModel.knex(knex)
ChunkModel.knex(knex)

const storeChunk = (ctx, filename, source, lang) => {
  ChunkModel.query()
    .insert({
      filename,
      userId: ctx.state.user.id,
      chatId: ctx.chat.id,
      lang,
      source,
    })
    .then()
    .catch(onError)
}

// const storeUser = (ctx, next) => {
//   UserModel.query()
//     .findById(chatUser(ctx).id)
//     .then((user) => {
//       if (user) {
//         ctx.state.user = user
//         return next(ctx)
//       }
//       return UserModel.query()
//         .insert({ ...chatUser(ctx), theme: 'github' })
//         .then((data) => {
//           ctx.state.user = data
//           makeUserFolder(data)
//           return next(ctx)
//         })
//         .catch(onError)
//     })
//     .catch(onError)
// }

const server = express()
const bot = new Telegraf(_env.BOT_TOKEN, { telegram: { webhookReply: true } })

server.use(bot.webhookCallback(`/${_env.WEBHOOK_PATH}`))

server.use('/images', express.static('images'))

server.post(
  `/${_env.WEBHOOK_PATH}`,
  (req, res) => bot.handleUpdate(req.body, res)
)

// Set telegram webhook
bot.telegram.setWebhook(`${url}${_env.WEBHOOK_PATH}`, tlsOptions.cert)

// Start Express Server
https
  .createServer(tlsOptions, server)
  .listen(_env.WEBHOOK_PORT, _env.WEBHOOK_DOMAIN)

/**
 * Log middleware
 */
bot.use((ctx, next) => {
  const start = new Date()

  return next(ctx).then(() => {
    console.log(ctx.message)
    console.log()
    console.log(ctx.from)
    console.log()
    console.log(`Response time ${(new Date()) - start}ms`)
    console.log('\n----------------------------------------\n')
  })
})

/**
 * User middleware
 */
bot.use((ctx, next) => ctx.state.user
  ? next(ctx)
  : UserModel.store(ctx, next))

/**
 * Start bot command
 */
bot.start((ctx) => isPrivateChat(ctx) && ctx.replyWithMarkdown(
  messages.welcomeUser(ctx.state.user || chatUser(ctx)),
  Markup.removeKeyboard().extra()
))

/**
 * Show languages list
 */
bot.command('langs', (ctx) => isPrivateChat(ctx)
  ? ctx.replyWithMarkdown(messages.langsList())
  : ctx.reply(messages.themeGroup))

/**
 * Show themes list
 */
bot.command('theme', (ctx) => isPrivateChat(ctx)
  ? ctx.replyWithMarkdown(
    messages.themeChoose(ctx.state.user.theme),
    Markup.keyboard(themesKeyboard(themes)).oneTime().resize().extra()
  )
  : ctx.reply(messages.themeGroup))

/**
 * Theme choose command
 */
bot.hears(/^🎨 (.+)/, (ctx) => {
  const theme = getThemeSlug(ctx.match[1])

  if (!themes.includes(theme)) return

  const body = messages.demoCode(getThemeName(theme))
  const filePath = getPath(getImageFileName(body, theme))

  webshot(messages.getHtml(body, theme), filePath, webshotOptions, (err) => {
    if (err) return console.log(err)

    ctx.replyWithChatAction('upload_photo')
    return ctx.replyWithPhoto(
      { url: getFileURL(filePath) },
      Markup
        .inlineKeyboard([
          Markup.callbackButton('Apply theme', `/apply/${theme}`),
        ])
        .removeKeyboard()
        .extra()
    )
  })
})

/**
 * Save theme
 */
bot.action(/^\/apply\/(.+)$/, (ctx) => UserModel.applyTheme(ctx))

/**
 * Catch code message
 */
bot.entity(({ type }) => type === 'pre', (ctx) => {
  const entity = ctx.message.entities.find((ent) => ent.type === 'pre')

  let code = ctx.message.text.slice(entity.offset, entity.offset + entity.length)
  const match = code.match(/^(\w+)\n/)
  const theme = ctx.state.user ? ctx.state.user.theme : 'github'
  const lang = match && match[1]

  if (match && langs.includes(lang)) {
    code = code.replace(new RegExp(match && match[0], 'i'), '')
  }

  const html = messages.getHtml(code, theme, lang)
  const imagePath = getPath(getImageFileName(html, theme))

  storeChunk(ctx, getImageFileName(html, theme), code, lang || 'auto')

  if (isExisted(imagePath)) {
    return replyWithPhoto(ctx, imagePath)
  }

  webshot(html, imagePath, webshotOptions, (err) => err
    ? console.log(err)
    : replyWithPhoto(ctx, imagePath))

  return true
})

/**
 * Inline query
 */
bot.on('inline_query', (ctx) => {
  let code = ctx.update.inline_query.query
  const match = code.match(/^(\w+)\n/)
  const lang = match && match[1]
  const theme = ctx.state.user ? ctx.state.user.theme : 'github'

  if (match && langs.includes(lang)) {
    code = code.replace(new RegExp(match && match[0], 'i'), '')
  }

  const html = messages.getHtml(code, theme, lang)
  const imagePath = getTempPath(getImageFileName(html, theme))

  if (isExisted(imagePath)) {
    return ctx.answerInlineQuery([getPhotoData(imagePath)])
  }

  webshot(html, imagePath, webshotOptions, (err) => err
    ? console.log(err)
    : ctx.answerInlineQuery([getPhotoData(imagePath)]))

  return true
})
// ctx.telegram.answerInlineQuery(ctx.inlineQuery.id, result)

/**
 * Bot was added to a group
 */
bot.on(['new_chat_members'], (ctx) => {
  if (ctx.message.new_chat_member.username !== _env.BOT_USER) return

  const onSuccess = () => ctx.replyWithMarkdown(messages.welcomeGroup())

  ChatModel.query()
    .findById(ctx.chat.id)
    .then((chat) => chat
      ? ChatModel.query()
        .patchAndFetchById(chat.id, { active: true })
        .then(onSuccess)
        .catch(onError)
      : ChatModel.query()
        .insert({
          id: ctx.chat.id,
          title: ctx.chat.title,
          type: ctx.chat.type,
          active: true,
        })
        .then(onSuccess)
        .catch(onError))
    .catch(onError)
})

/**
 * Bot was removed from group
 */
bot.on(['left_chat_member'], (ctx) => {
  if (ctx.message.left_chat_member.username !== _env.BOT_USER) return

  ChatModel.query()
    .patchAndFetchById(ctx.chat.id, { active: false })
    .then()
    .catch(onError)
})

bot.hears(/.*/, ({ reply, match }) => {
  reply('Hey there!').then(() => reply(match[0]))
})
