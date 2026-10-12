'use strict';

const { digestObject, failure } = require('./provider-common');

// Reject route selectors rather than silently scrubbing a conflicting active login.
const FORBIDDEN_ENV = /^(?:OPENAI_API_KEY|OPENAI_BASE_URL|OPENAI_ORG_ID|OPENAI_ORGANIZATION|CODEX_API_KEY|CODEX_BASE_URL|CODEX_CA_ROOT_CERT|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_BEDROCK_BASE_URL|ANTHROPIC_FOUNDRY_API_KEY|ANTHROPIC_FOUNDRY_BASE_URL|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY|CLAUDE_CODE_API_KEY_HELPER|AWS_BEARER_TOKEN_BEDROCK|GOOGLE_APPLICATION_CREDENTIALS|CLOUD_ML_REGION)$/;

function assertSubscriptionEnvironment(env) {
  if (!env || typeof env !== 'object' || Object.entries(env).some(([key, value]) => FORBIDDEN_ENV.test(key) && value !== undefined && value !== '')) {
    throw failure('ECC_ALLOCATION_SUBSCRIPTION_REQUIRED', 'Conflicting subscription authentication or backend route');
  }
}

function computeSubscriptionRouteDigest({ provider, observation }) {
  const configDigests = [...(observation.configDigests || [])].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return digestObject({ schemaVersion: 'ecc.subscription-route.v1', providerId: provider.id,
    target: provider.target, method: observation.method, executableDigest: observation.executableDigest,
    environmentMode: provider.environmentMode, providerHomeDigest: digestObject(observation.providerHome),
    knownConfigDigest: digestObject(configDigests), backendClass: 'native-subscription',
    authClass: provider.target === 'codex' ? 'chatgpt' : 'claude-oauth' });
}

function validateSubscriptionBinding({ provider, observation }) {
  const expectedMethod = provider.target === 'codex' ? 'codex-chatgpt' : 'claude-oauth';
  if (!observation || observation.authenticated !== true || observation.method !== expectedMethod
    || provider.authRoute?.mode !== 'subscription-only' || provider.authRoute.method !== expectedMethod) {
    throw failure('ECC_ALLOCATION_AUTH_ROUTE_UNVERIFIED', 'Subscription route cannot be verified');
  }
  if (provider.authRoute.paidExtraUsageDisabled !== true || observation.paidExtraUsageDisabled !== true
    || observation.overageObserved !== false || !['openai', 'anthropic'].includes(observation.backendId)
    || observation.backendId !== (provider.target === 'codex' ? 'openai' : 'anthropic')) {
    throw failure('ECC_ALLOCATION_SUBSCRIPTION_REQUIRED', 'Subscription billing route is contradictory or unknown');
  }
  const routeDigest = computeSubscriptionRouteDigest({ provider, observation });
  if (routeDigest !== provider.authRoute.expectedRouteDigest) {
    throw failure('ECC_ALLOCATION_BINDING_CHANGED', 'Subscription route binding changed');
  }
  return { routeDigest, method: expectedMethod, authenticated: true };
}

module.exports = { validateSubscriptionBinding, computeSubscriptionRouteDigest, assertSubscriptionEnvironment, FORBIDDEN_ENV };
