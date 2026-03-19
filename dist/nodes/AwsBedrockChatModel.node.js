"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AwsBedrockChatModel = void 0;
const chat_models_1 = require("@langchain/core/language_models/chat_models");
const messages_1 = require("@langchain/core/messages");
const client_sts_1 = require("@aws-sdk/client-sts");
const client_bedrock_runtime_1 = require("@aws-sdk/client-bedrock-runtime");
const credential_providers_1 = require("@aws-sdk/credential-providers");
// Import shared utilities from the main node
const AwsBedrockAssumeRole_node_1 = require("./AwsBedrockAssumeRole.node");
// Module-level cache for temporary credentials (shared with main node)
const credentialCache = {};
// Resolve base credentials from provided fields or environment variables
function resolveBase(credentials) {
    const fromEnv = (v) => (typeof v === 'string' ? v.trim() : v);
    return {
        accessKeyId: credentials.accessKeyId || fromEnv(process.env.AWS_ACCESS_KEY_ID),
        secretAccessKey: credentials.secretAccessKey || fromEnv(process.env.AWS_SECRET_ACCESS_KEY),
        roleArn: credentials.roleArn || fromEnv(process.env.AWS_ROLE_ARN),
        region: credentials.region || fromEnv(process.env.AWS_REGION) || 'us-east-1',
        durationSeconds: credentials.durationSeconds || 3600,
    };
}
// Get cached credentials or fetch new ones
async function getCachedOrFetchCredentials(credentials) {
    const cacheKey = `${credentials.accessKeyId}:${credentials.roleArn}`;
    const cached = credentialCache[cacheKey];
    // Check if cached credentials are still valid (with 5-minute buffer)
    if (cached && cached.Expiration) {
        const expirationTime = new Date(cached.Expiration).getTime();
        const now = Date.now();
        const bufferMs = 5 * 60 * 1000; // 5 minutes
        if (expirationTime - now > bufferMs) {
            return cached;
        }
    }
    // Fetch new credentials
    const newCreds = await assumeRole(credentials);
    credentialCache[cacheKey] = newCreds;
    return newCreds;
}
// Execute AssumeRole
async function assumeRole(credentials) {
    const fromEnv = (v) => (typeof v === 'string' ? v.trim() : v);
    const accessKeyId = credentials.accessKeyId || fromEnv(process.env.AWS_ACCESS_KEY_ID);
    const secretAccessKey = credentials.secretAccessKey || fromEnv(process.env.AWS_SECRET_ACCESS_KEY);
    const region = credentials.region || fromEnv(process.env.AWS_REGION) || 'us-east-1';
    const roleArn = credentials.roleArn || fromEnv(process.env.AWS_ROLE_ARN);
    if (!roleArn) {
        throw new Error('Missing Role ARN to assume');
    }
    // Use explicit credentials if provided, otherwise fall back to the default
    // AWS credential provider chain (ECS task role, instance profile, env vars, etc.)
    const stsCredentials = accessKeyId && secretAccessKey
        ? { accessKeyId, secretAccessKey }
        : (0, credential_providers_1.fromNodeProviderChain)();
    const sts = new client_sts_1.STSClient({
        region,
        credentials: stsCredentials,
    });
    const assumeRoleParams = {
        RoleArn: roleArn,
        RoleSessionName: 'n8n-bedrock-chat-session',
        DurationSeconds: credentials.durationSeconds || 3600,
    };
    if (credentials.externalId) {
        assumeRoleParams.ExternalId = credentials.externalId;
    }
    const result = await sts.send(new client_sts_1.AssumeRoleCommand(assumeRoleParams));
    if (!result.Credentials) {
        throw new Error('Failed to obtain temporary credentials from STS');
    }
    return result.Credentials;
}
// Custom AWS Bedrock Chat Model implementation
class AwsBedrockChatModelInstance extends chat_models_1.BaseChatModel {
    constructor(fields) {
        super({});
        this.modelId = fields.modelId;
        this.credentials = fields.credentials;
        this.region = fields.region;
        this.maxTokens = fields.maxTokens || 4096;
        this.temperature = fields.temperature !== undefined ? fields.temperature : 0.7;
        this.effectiveModelId = fields.effectiveModelId;
        this.tools = fields.tools;
    }
    _llmType() {
        return 'aws-bedrock-chat';
    }
    // Implement bindTools to support tool calling
    bindTools(tools) {
        return new AwsBedrockChatModelInstance({
            modelId: this.modelId,
            credentials: this.credentials,
            region: this.region,
            maxTokens: this.maxTokens,
            temperature: this.temperature,
            effectiveModelId: this.effectiveModelId,
            tools,
        });
    }
    // Convert LangChain messages to Claude format
    convertMessagesToClaudeFormat(messages) {
        const systemMessages = [];
        const conversationMessages = [];
        for (const message of messages) {
            // Use _getType() method instead of instanceof to handle cross-version compatibility
            const messageType = message._getType();
            if (messageType === 'system' || message instanceof messages_1.SystemMessage) {
                systemMessages.push(message.content);
            }
            else if (messageType === 'human' || message instanceof messages_1.HumanMessage) {
                conversationMessages.push({
                    role: 'user',
                    content: message.content,
                });
            }
            else if (messageType === 'ai' || message instanceof messages_1.AIMessage) {
                // Handle AI messages with tool calls
                const content = [];
                const aiMessage = message;
                // Add text content if present
                if (aiMessage.content) {
                    content.push({
                        type: 'text',
                        text: aiMessage.content,
                    });
                }
                // Add tool use blocks if present
                if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
                    for (const toolCall of aiMessage.tool_calls) {
                        content.push({
                            type: 'tool_use',
                            id: toolCall.id || `tool_${Date.now()}`,
                            name: toolCall.name,
                            input: toolCall.args,
                        });
                    }
                }
                conversationMessages.push({
                    role: 'assistant',
                    content: content.length === 1 && content[0].type === 'text' ? content[0].text : content,
                });
            }
            else if (messageType === 'tool' || message instanceof messages_1.ToolMessage) {
                // Handle tool result messages
                conversationMessages.push({
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: message.tool_call_id,
                            content: message.content,
                        },
                    ],
                });
            }
        }
        const result = {
            messages: conversationMessages,
        };
        if (systemMessages.length > 0) {
            result.system = systemMessages.join('\n\n');
        }
        return result;
    }
    async _generate(messages, _options, _runManager) {
        // Get temporary credentials via AssumeRole
        const tempCreds = await getCachedOrFetchCredentials(this.credentials);
        // Create Bedrock client with temporary credentials
        const bedrockClient = new client_bedrock_runtime_1.BedrockRuntimeClient({
            region: this.region,
            credentials: {
                accessKeyId: tempCreds.AccessKeyId,
                secretAccessKey: tempCreds.SecretAccessKey,
                sessionToken: tempCreds.SessionToken,
            },
        });
        // Convert messages to Claude format
        const { system, messages: claudeMessages } = this.convertMessagesToClaudeFormat(messages);
        // Validate that we have at least one conversation message
        if (!claudeMessages || claudeMessages.length === 0) {
            throw new Error('No conversation messages found. The AI Agent must provide at least one user message. ' +
                'Received messages: ' + JSON.stringify(messages.map(m => ({ type: m._getType(), content: m.content }))) +
                '. This usually happens when the AI Agent node is not properly configured or when using promptType="define" without a text prompt.');
        }
        // Build request body for Claude models
        const requestBody = {
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: this.maxTokens,
            messages: claudeMessages,
        };
        if (system) {
            requestBody.system = system;
        }
        if (this.temperature !== undefined) {
            requestBody.temperature = this.temperature;
        }
        // Add tools if present
        if (this.tools && this.tools.length > 0) {
            requestBody.tools = this.tools.map((tool) => {
                // Convert tool schema to Claude format
                let inputSchema = { type: 'object', properties: {}, required: [] };
                // Handle Zod schema or JSON schema
                if (typeof tool.schema === 'object' && tool.schema !== null) {
                    // Try to access as JSON schema first
                    const schema = tool.schema;
                    if (schema.properties) {
                        inputSchema.properties = schema.properties;
                    }
                    if (schema.required) {
                        inputSchema.required = schema.required;
                    }
                }
                return {
                    name: tool.name,
                    description: tool.description,
                    input_schema: inputSchema,
                };
            });
        }
        // Invoke the model
        const command = new client_bedrock_runtime_1.InvokeModelCommand({
            modelId: this.effectiveModelId,
            body: JSON.stringify(requestBody),
            contentType: 'application/json',
            accept: 'application/json',
        });
        const response = await bedrockClient.send(command);
        const responseBody = JSON.parse(new TextDecoder().decode(response.body));
        // Extract the response text and tool calls
        let text = '';
        const toolCalls = [];
        if (responseBody.content && Array.isArray(responseBody.content)) {
            for (const block of responseBody.content) {
                if (block.type === 'text') {
                    text += block.text;
                }
                else if (block.type === 'tool_use') {
                    toolCalls.push({
                        id: block.id,
                        name: block.name,
                        args: block.input,
                    });
                }
            }
        }
        else {
            // Fallback for older response format
            text = responseBody.completion || '';
        }
        // Create the AI message with tool calls if present
        const aiMessage = new messages_1.AIMessage({
            content: text,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        });
        // Create the chat generation
        const generation = {
            text,
            message: aiMessage,
            generationInfo: {
                usage: responseBody.usage,
                stop_reason: responseBody.stop_reason,
            },
        };
        return {
            generations: [generation],
            llmOutput: {
                usage: responseBody.usage,
                stop_reason: responseBody.stop_reason,
            },
        };
    }
}
class AwsBedrockChatModel {
    constructor() {
        this.description = {
            displayName: 'AWS Bedrock Chat Model (AssumeRole)',
            name: 'awsBedrockChatModelAssumeRole',
            icon: 'file:bedrock.svg',
            group: ['transform'],
            version: 1,
            description: 'AWS Bedrock Chat Model for AI Agent with AssumeRole authentication',
            defaults: {
                name: 'AWS Bedrock Chat Model (AssumeRole)',
            },
            codex: {
                categories: ['AI'],
                subcategories: {
                    AI: ['Language Models'],
                },
                resources: {
                    primaryDocumentation: [
                        {
                            url: 'https://github.com/cabify/n8n-nodes-aws-bedrock-assumerole',
                        },
                    ],
                },
            },
            // eslint-disable-next-line n8n-nodes-base/node-class-description-inputs-wrong-regular-node
            inputs: [],
            // eslint-disable-next-line n8n-nodes-base/node-class-description-outputs-wrong
            outputs: ['ai_languageModel'],
            outputNames: ['Model'],
            credentials: [
                {
                    name: 'awsAssumeRole',
                    required: true,
                },
            ],
            properties: [
                {
                    displayName: 'Model',
                    name: 'model',
                    type: 'options',
                    description: 'The model to use. When Application Inference Profiles JSON is configured in the credentials, only the models present in that JSON will be listed here.',
                    default: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
                    options: [],
                    typeOptions: {
                        loadOptionsMethod: 'getModelOptions',
                    },
                },
            ],
        };
        this.methods = {
            loadOptions: {
                async getModelOptions() {
                    const staticOptions = [
                        {
                            name: 'Claude 3.5 Sonnet v2',
                            value: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
                        },
                        {
                            name: 'Claude 3.5 Sonnet v1',
                            value: 'us.anthropic.claude-3-5-sonnet-20240620-v1:0',
                        },
                        {
                            name: 'Claude 3.5 Haiku',
                            value: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
                        },
                        {
                            name: 'Claude 3.7 Sonnet',
                            value: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
                        },
                        {
                            name: 'Claude Sonnet 4',
                            value: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
                        },
                        {
                            name: 'Claude Sonnet 4.5',
                            value: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
                        },
                        {
                            name: 'Claude Haiku 4.5',
                            value: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
                        },
                        {
                            name: 'Claude Opus 4',
                            value: 'us.anthropic.claude-opus-4-20250514-v1:0',
                        },
                        {
                            name: 'Claude Opus 4.1',
                            value: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
                        },
                        {
                            name: 'Claude Opus 4.6',
                            value: 'us.anthropic.claude-opus-4-6-v1:0',
                        },
                        {
                            name: 'Claude Sonnet 4.6',
                            value: 'us.anthropic.claude-sonnet-4-6-v1:0',
                        },
                    ];
                    let credential;
                    try {
                        credential = await this.getCredentials('awsAssumeRole');
                    }
                    catch {
                        // If credentials are not configured yet, fall back to static options
                        return staticOptions;
                    }
                    const rawCredsRecord = credential;
                    const jsonText = rawCredsRecord.applicationInferenceProfilesJson;
                    if (!jsonText || typeof jsonText !== 'string' || !jsonText.trim()) {
                        return staticOptions;
                    }
                    let profilesContainer;
                    try {
                        profilesContainer = (0, AwsBedrockAssumeRole_node_1.buildApplicationInferenceProfilesFromJson)(jsonText);
                    }
                    catch (error) {
                        // Surface the same descriptive message the node would use at execution time
                        throw new Error(error?.message ?? String(error));
                    }
                    if (!profilesContainer?.profiles || profilesContainer.profiles.length === 0) {
                        return staticOptions;
                    }
                    const labelByModelId = {};
                    for (const option of staticOptions) {
                        if (typeof option.value === 'string') {
                            labelByModelId[option.value] = option.name.toString();
                        }
                    }
                    const options = [];
                    for (const profile of profilesContainer.profiles) {
                        const modelId = profile.modelId?.toString().trim();
                        if (!modelId)
                            continue;
                        const label = labelByModelId[modelId] || modelId;
                        options.push({
                            name: label,
                            value: modelId,
                        });
                    }
                    return options;
                },
            },
        };
    }
    async supplyData(itemIndex) {
        const modelId = this.getNodeParameter('model', itemIndex);
        const credentials = await this.getCredentials('awsAssumeRole');
        // Resolve credentials
        const resolved = resolveBase(credentials);
        // Resolve effective model identifier (optionally using application inference profile)
        const rawCredsRecord = credentials;
        const applicationInferenceProfileAccountId = rawCredsRecord.applicationInferenceProfileAccountId;
        const applicationInferenceProfileId = rawCredsRecord.applicationInferenceProfileId;
        const applicationInferenceProfilesJson = rawCredsRecord.applicationInferenceProfilesJson;
        let applicationInferenceProfiles = rawCredsRecord.applicationInferenceProfiles;
        if (!applicationInferenceProfiles && applicationInferenceProfilesJson) {
            applicationInferenceProfiles = (0, AwsBedrockAssumeRole_node_1.buildApplicationInferenceProfilesFromJson)(applicationInferenceProfilesJson);
        }
        const effectiveModelId = (0, AwsBedrockAssumeRole_node_1.resolveEffectiveModelId)({
            modelId,
            region: resolved.region,
            applicationInferenceProfileAccountId,
            applicationInferenceProfileId,
            applicationInferenceProfiles,
        });
        // Create the chat model instance
        const model = new AwsBedrockChatModelInstance({
            modelId,
            credentials: resolved,
            region: resolved.region,
            maxTokens: 4096,
            temperature: 0.7,
            effectiveModelId,
        });
        return {
            response: model,
        };
    }
}
exports.AwsBedrockChatModel = AwsBedrockChatModel;
