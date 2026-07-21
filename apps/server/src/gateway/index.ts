// EXECUTION E9 — the provider-native streaming gateway.
//
// One import surface, so server.ts's E9 section stays a single block and
// nothing outside this directory reaches into the gateway's internals.
export {
  GATEWAY_CREDENTIAL_TTL_MS,
  GATEWAY_TOKEN_PREFIX,
  GatewayCredentialService,
  InMemoryGatewayCredentialStore,
  SqlGatewayCredentialStore,
  digestsEqual,
  hashGatewayToken,
  type GatewayCredentialFailure,
  type GatewayCredentialRecord,
  type GatewayCredentialResolution,
  type GatewayCredentialStore,
  type MintedGatewayCredential,
} from "./credentials.js";
export {
  ANTHROPIC_SURFACE,
  GATEWAY_REFUSAL_HEADER,
  OPENAI_SURFACE,
  ProviderGateway,
  SURFACES,
  extractGatewayCredential,
  refusalBody,
  type GatewayForwardInput,
  type GatewayKeyResolver,
  type GatewayRefusalCode,
  type GatewayResult,
  type GatewaySurface,
  type ProviderGatewayOptions,
} from "./providerGateway.js";
export {
  estimateGatewayInputTokens,
  inspectGatewayRequest,
  type GatewayInspection,
  type InspectedGatewayRequest,
} from "./request.js";
export {
  GATEWAY_CREDENTIAL_ROUTE,
  GATEWAY_ROUTE_PREFIX,
  anthropicGatewayBaseUrl,
  openAiGatewayBaseUrl,
  registerGatewayRoutes,
  type GatewayRouteDependencies,
} from "./routes.js";
export {
  GatewayUsageTap,
  SseEventReassembler,
  billableInputTokens,
  emptyUsage,
  isEventStream,
  type GatewayProvider,
  type GatewayTokenUsage,
} from "./usage.js";
