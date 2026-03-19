import type {
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	SupplyData,
	ILoadOptionsFunctions,
	INodePropertyOptions,
} from 'n8n-workflow';

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
	BaseMessage,
	AIMessage,
	HumanMessage,
	SystemMessage,
	ToolMessage,
} from '@langchain/core/messages';
import { ChatResult, ChatGeneration } from '@langchain/core/outputs';
import { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { StructuredToolInterface } from '@langchain/core/tools';

import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

// Import shared utilities from the main node
import {
	resolveEffectiveModelId,
	buildApplicationInferenceProfilesFromJson,
} from './AwsBedrockAssumeRole.node';

// Module-level cache for temporary credentials (shared with main node)
const credentialCache: { [key: string]: any } = {};

// Resolve base credentials from provided fields or environment variables
function resolveBase(credentials: any) {
	const fromEnv = (v: any) => (typeof v === 'string' ? v.trim() : v);
	return {
		accessKeyId: credentials.accessKeyId || fromEnv(process.env.AWS_ACCESS_KEY_ID),
		secretAccessKey: credentials.secretAccessKey || fromEnv(process.env.AWS_SECRET_ACCESS_KEY),
		roleArn: credentials.roleArn || fromEnv(process.env.AWS_ROLE_ARN),
		region: credentials.region || fromEnv(process.env.AWS_REGION) || 'us-east-1',
		durationSeconds: credentials.durationSeconds || 3600,
	};
}

// Get cached credentials or fetch new ones
async function getCachedOrFetchCredentials(credentials: any) {
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
async function assumeRole(credentials: any) {
	const fromEnv = (v: any) => (typeof v === 'string' ? v.trim() : v);
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
		: fromNodeProviderChain();

	const sts = new STSClient({
		region,
		credentials: stsCredentials,
	});

	const result = await sts.send(
		new AssumeRoleCommand({
			RoleArn: roleArn,
			RoleSessionName: 'n8n-bedrock-chat-session',
			DurationSeconds: credentials.durationSeconds || 3600,
		}),
	);

	if (!result.Credentials) {
		throw new Error('Failed to obtain temporary credentials from STS');
	}

	return result.Credentials;
}

// Custom AWS Bedrock Chat Model implementation
class AwsBedrockChatModelInstance extends BaseChatModel {
	modelId: string;
	credentials: any;
	region: string;
	maxTokens: number;
	temperature: number;
	effectiveModelId: string;
	tools?: StructuredToolInterface[];

	constructor(fields: {
		modelId: string;
		credentials: any;
		region: string;
		maxTokens?: number;
		temperature?: number;
		effectiveModelId: string;
		tools?: StructuredToolInterface[];
	}) {
		super({});
		this.modelId = fields.modelId;
		this.credentials = fields.credentials;
		this.region = fields.region;
		this.maxTokens = fields.maxTokens || 4096;
		this.temperature = fields.temperature !== undefined ? fields.temperature : 0.7;
		this.effectiveModelId = fields.effectiveModelId;
		this.tools = fields.tools;
	}

	_llmType(): string {
		return 'aws-bedrock-chat';
	}

	// Implement bindTools to support tool calling
	override bindTools(tools: StructuredToolInterface[]): this {
		return new AwsBedrockChatModelInstance({
			modelId: this.modelId,
			credentials: this.credentials,
			region: this.region,
			maxTokens: this.maxTokens,
			temperature: this.temperature,
			effectiveModelId: this.effectiveModelId,
			tools,
		}) as this;
	}

	// Convert LangChain messages to Claude format
	private convertMessagesToClaudeFormat(messages: BaseMessage[]): {
		system?: string;
		messages: Array<{ role: string; content: any }>;
	} {
		const systemMessages: string[] = [];
		const conversationMessages: Array<{ role: string; content: any }> = [];

		for (const message of messages) {
			// Use _getType() method instead of instanceof to handle cross-version compatibility
			const messageType = message._getType();

			if (messageType === 'system' || message instanceof SystemMessage) {
				systemMessages.push(message.content as string);
			} else if (messageType === 'human' || message instanceof HumanMessage) {
				conversationMessages.push({
					role: 'user',
					content: message.content as string,
				});
			} else if (messageType === 'ai' || message instanceof AIMessage) {
				// Handle AI messages with tool calls
				const content: any[] = [];
				const aiMessage = message as AIMessage;

				// Add text content if present
				if (aiMessage.content) {
					content.push({
						type: 'text',
						text: aiMessage.content as string,
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
			} else if (messageType === 'tool' || message instanceof ToolMessage) {
				// Handle tool result messages
				conversationMessages.push({
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: (message as any).tool_call_id,
							content: message.content as string,
						},
					],
				});
			}
		}

		const result: { system?: string; messages: Array<{ role: string; content: any }> } = {
			messages: conversationMessages,
		};

		if (systemMessages.length > 0) {
			result.system = systemMessages.join('\n\n');
		}

		return result;
	}

	async _generate(
		messages: BaseMessage[],
		_options?: this['ParsedCallOptions'],
		_runManager?: CallbackManagerForLLMRun,
	): Promise<ChatResult> {
		// Get temporary credentials via AssumeRole
		const tempCreds = await getCachedOrFetchCredentials(this.credentials);

		// Create Bedrock client with temporary credentials
		const bedrockClient = new BedrockRuntimeClient({
			region: this.region,
			credentials: {
				accessKeyId: tempCreds.AccessKeyId!,
				secretAccessKey: tempCreds.SecretAccessKey!,
				sessionToken: tempCreds.SessionToken!,
			},
		});

		// Convert messages to Claude format
		const { system, messages: claudeMessages } = this.convertMessagesToClaudeFormat(messages);

		// Validate that we have at least one conversation message
		if (!claudeMessages || claudeMessages.length === 0) {
			throw new Error(
				'No conversation messages found. The AI Agent must provide at least one user message. ' +
				'Received messages: ' + JSON.stringify(messages.map(m => ({ type: m._getType(), content: m.content }))) +
				'. This usually happens when the AI Agent node is not properly configured or when using promptType="define" without a text prompt.'
			);
		}

		// Build request body for Claude models
		const requestBody: any = {
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
				let inputSchema: any = { type: 'object', properties: {}, required: [] };

				// Handle Zod schema or JSON schema
				if (typeof tool.schema === 'object' && tool.schema !== null) {
					// Try to access as JSON schema first
					const schema = tool.schema as any;
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
		const command = new InvokeModelCommand({
			modelId: this.effectiveModelId,
			body: JSON.stringify(requestBody),
			contentType: 'application/json',
			accept: 'application/json',
		});

		const response = await bedrockClient.send(command);
		const responseBody = JSON.parse(new TextDecoder().decode(response.body));

		// Extract the response text and tool calls
		let text = '';
		const toolCalls: any[] = [];

		if (responseBody.content && Array.isArray(responseBody.content)) {
			for (const block of responseBody.content) {
				if (block.type === 'text') {
					text += block.text;
				} else if (block.type === 'tool_use') {
					toolCalls.push({
						id: block.id,
						name: block.name,
						args: block.input,
					});
				}
			}
		} else {
			// Fallback for older response format
			text = responseBody.completion || '';
		}

		// Create the AI message with tool calls if present
		const aiMessage = new AIMessage({
			content: text,
			tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
		});

		// Create the chat generation
		const generation: ChatGeneration = {
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

export class AwsBedrockChatModel implements INodeType {
	description: INodeTypeDescription = {
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
				description:
					'The model to use. When Application Inference Profiles JSON is configured in the credentials, only the models present in that JSON will be listed here.',
				default: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
				options: [],
				typeOptions: {
					loadOptionsMethod: 'getModelOptions',
				},
			},
		],
	};

	methods = {
		loadOptions: {
			async getModelOptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const staticOptions: INodePropertyOptions[] = [
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
				];

				let credential: unknown;
				try {
					credential = await this.getCredentials('awsAssumeRole');
				} catch {
					// If credentials are not configured yet, fall back to static options
					return staticOptions;
				}

				const rawCredsRecord = credential as { [key: string]: any };
				const jsonText = rawCredsRecord.applicationInferenceProfilesJson as string | undefined;

				if (!jsonText || typeof jsonText !== 'string' || !jsonText.trim()) {
					return staticOptions;
				}

				let profilesContainer;
				try {
					profilesContainer = buildApplicationInferenceProfilesFromJson(jsonText);
				} catch (error: any) {
					// Surface the same descriptive message the node would use at execution time
					throw new Error(error?.message ?? String(error));
				}

				if (!profilesContainer?.profiles || profilesContainer.profiles.length === 0) {
					return staticOptions;
				}

				const labelByModelId: Record<string, string> = {};
				for (const option of staticOptions) {
					if (typeof option.value === 'string') {
						labelByModelId[option.value] = option.name.toString();
					}
				}

				const options: INodePropertyOptions[] = [];
				for (const profile of profilesContainer.profiles) {
					const modelId = profile.modelId?.toString().trim();
					if (!modelId) continue;

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

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const modelId = this.getNodeParameter('model', itemIndex) as string;
		const credentials = await this.getCredentials('awsAssumeRole');

		// Resolve credentials
		const resolved = resolveBase(credentials);

		// Resolve effective model identifier (optionally using application inference profile)
		const rawCredsRecord = credentials as { [key: string]: any };
		const applicationInferenceProfileAccountId =
			rawCredsRecord.applicationInferenceProfileAccountId as string | undefined;
		const applicationInferenceProfileId =
			rawCredsRecord.applicationInferenceProfileId as string | undefined;
		const applicationInferenceProfilesJson =
			rawCredsRecord.applicationInferenceProfilesJson as string | undefined;

		let applicationInferenceProfiles = rawCredsRecord.applicationInferenceProfiles as unknown;

		if (!applicationInferenceProfiles && applicationInferenceProfilesJson) {
			applicationInferenceProfiles = buildApplicationInferenceProfilesFromJson(
				applicationInferenceProfilesJson,
			);
		}

		const effectiveModelId = resolveEffectiveModelId({
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

