import { Elysia } from 'elysia'
import { accessLogPlugin } from './plugins/access'
import { corsPlugin } from './plugins/cors'
import { errorsPlugin } from './plugins/errors'
import { bodyLimitPlugin } from './plugins/body'
import { authPlugin } from './plugins/auth'
import { healthController } from './modules/health/index'
import { modelsController } from './modules/models/index'
import { billingController } from './modules/billing/index'
import { chatController } from './modules/chat/index'
import { messagesController } from './modules/messages/index'
import { responsesController } from './modules/responses/index'

export function createApp() {
  return new Elysia()
    // Access log first: it only contributes hooks (no routes), so ordering is
    // about hook precedence, not behaviour. Its scoped afterHandle/onError
    // then cover every controller registered below.
    .use(accessLogPlugin)
    .use(corsPlugin)
    .use(errorsPlugin)
    .use(bodyLimitPlugin)
    .use(authPlugin)
    .use(healthController)
    .use(modelsController)
    .use(billingController)
    .use(chatController)
    .use(messagesController)
    .use(responsesController)
}
