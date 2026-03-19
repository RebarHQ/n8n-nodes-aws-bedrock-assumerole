"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AwsBedrockAssumeRole = void 0;
exports.resolveEffectiveModelId = resolveEffectiveModelId;
exports.buildApplicationInferenceProfilesFromJson = buildApplicationInferenceProfilesFromJson;
exports.isImageGenerationModel = isImageGenerationModel;
exports.buildImageGenerationRequestBody = buildImageGenerationRequestBody;
exports.buildClaudeMessageContent = buildClaudeMessageContent;
const n8n_workflow_1 = require("n8n-workflow");
const client_sts_1 = require("@aws-sdk/client-sts");
const client_bedrock_runtime_1 = require("@aws-sdk/client-bedrock-runtime");
const credential_providers_1 = require("@aws-sdk/credential-providers");
// Module-level cache for temporary credentials
const credentialCache = {};
// Resolve base credentials from provided fields or environment variables (with trimming)
function resolveBase(credentials) {
    const fromEnv = (v) => (typeof v === 'string' ? v.trim() : v);
    const resolved = {
        accessKeyId: credentials.accessKeyId || fromEnv(process.env.AWS_ACCESS_KEY_ID),
        secretAccessKey: credentials.secretAccessKey || fromEnv(process.env.AWS_SECRET_ACCESS_KEY),
        roleArn: credentials.roleArn || fromEnv(process.env.AWS_ROLE_ARN),
        region: credentials.region || fromEnv(process.env.AWS_REGION) || 'us-east-1',
        durationSeconds: credentials.durationSeconds || 3600,
        externalId: credentials.externalId || '',
    };
    console.log('[AWS Bedrock] Resolved credentials:', {
        accessKeyIdSource: credentials.accessKeyId ? 'credential' : 'env',
        accessKeyIdPrefix: resolved.accessKeyId ? resolved.accessKeyId.substring(0, 8) + '...' : 'MISSING',
        secretAccessKeySource: credentials.secretAccessKey ? 'credential' : 'env',
        secretAccessKeyLength: resolved.secretAccessKey ? resolved.secretAccessKey.length : 0,
        roleArn: resolved.roleArn,
        region: resolved.region,
        durationSeconds: resolved.durationSeconds,
    });
    return resolved;
}
// Resolve effective model identifier based on optional application inference profile configuration
function resolveEffectiveModelId(params) {
    const baseModelId = params.modelId;
    const accountId = params.applicationInferenceProfileAccountId?.toString().trim();
    // If there is no account configured for application inference profiles, fall back to the base model ID
    if (!accountId) {
        return baseModelId;
    }
    // Prefer per-model profile configuration when available
    const profilesContainer = params.applicationInferenceProfiles;
    let profileId;
    if (profilesContainer?.profiles && Array.isArray(profilesContainer.profiles)) {
        const matchedProfile = profilesContainer.profiles.find((profile) => {
            const profileModelId = profile.modelId?.toString().trim();
            return profileModelId === baseModelId;
        });
        if (matchedProfile?.profileId) {
            profileId = matchedProfile.profileId.toString().trim();
        }
    }
    // Fallback to legacy single profile id if still provided
    if (!profileId && params.applicationInferenceProfileId) {
        profileId = params.applicationInferenceProfileId.toString().trim();
    }
    if (profileId) {
        return `arn:aws:bedrock:${params.region}:${accountId}:application-inference-profile/${profileId}`;
    }
    // No profile configured for this model - use standard model id
    return baseModelId;
}
// Build application inference profiles container from JSON mapping in credentials
function buildApplicationInferenceProfilesFromJson(jsonText) {
    if (!jsonText || typeof jsonText !== 'string') {
        return undefined;
    }
    const trimmed = jsonText.trim();
    if (!trimmed) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== 'object') {
            return undefined;
        }
        const profiles = [];
        for (const [modelId, profileId] of Object.entries(parsed)) {
            if (typeof modelId === 'string' && typeof profileId === 'string') {
                const normalizedModelId = modelId.trim();
                const normalizedProfileId = profileId.trim();
                if (normalizedModelId && normalizedProfileId) {
                    profiles.push({
                        modelId: normalizedModelId,
                        profileId: normalizedProfileId,
                    });
                }
            }
        }
        if (profiles.length === 0) {
            return undefined;
        }
        return { profiles };
    }
    catch (error) {
        throw new Error(`Invalid JSON in \"Application Inference Profiles JSON\" credential field: ${error?.message ?? String(error)}`);
    }
}
// Image generation model IDs
const IMAGE_GENERATION_MODELS = [
    'amazon.nova-canvas-v1:0',
    'amazon.titan-image-generator-v2:0',
];
// Check if a model ID is an image generation model
function isImageGenerationModel(modelId) {
    return IMAGE_GENERATION_MODELS.some((id) => modelId.includes(id));
}
// Build request body for image generation models (Nova Canvas, Titan Image)
function buildImageGenerationRequestBody(args) {
    // For INPAINTING, OUTPAINTING, and BACKGROUND_REMOVAL, width/height should NOT be included
    // The output size will match the input image size automatically
    const tasksWithoutDimensions = ['INPAINTING', 'OUTPAINTING', 'BACKGROUND_REMOVAL'];
    const includeDimensions = !tasksWithoutDimensions.includes(args.taskType);
    const imageGenerationConfig = {
        quality: args.quality,
        numberOfImages: args.numberOfImages,
    };
    // Only include width/height for TEXT_IMAGE and IMAGE_VARIATION
    if (includeDimensions && args.width && args.height) {
        imageGenerationConfig.width = args.width;
        imageGenerationConfig.height = args.height;
    }
    // Add seed if provided and not 0 (0 means random)
    if (args.seed && args.seed > 0) {
        imageGenerationConfig.seed = args.seed;
    }
    else {
        // Generate random seed for reproducibility logging
        imageGenerationConfig.seed = Math.floor(Math.random() * 858993460);
    }
    // Add cfgScale for Titan Image models (not for background removal)
    if (args.modelId.includes('titan-image') && args.cfgScale !== undefined && args.taskType !== 'BACKGROUND_REMOVAL') {
        imageGenerationConfig.cfgScale = args.cfgScale;
    }
    // Build request body based on task type
    switch (args.taskType) {
        case 'TEXT_IMAGE': {
            const textToImageParams = {
                text: args.prompt,
            };
            if (args.negativePrompt && args.negativePrompt.trim()) {
                textToImageParams.negativeText = args.negativePrompt.trim();
            }
            return {
                taskType: 'TEXT_IMAGE',
                textToImageParams,
                imageGenerationConfig,
            };
        }
        case 'INPAINTING': {
            const inPaintingParams = {
                image: args.sourceImageBase64,
            };
            if (args.prompt && args.prompt.trim()) {
                inPaintingParams.text = args.prompt.trim();
            }
            if (args.negativePrompt && args.negativePrompt.trim()) {
                inPaintingParams.negativeText = args.negativePrompt.trim();
            }
            // Mask: either maskPrompt or maskImage (not both)
            if (args.maskImageBase64) {
                inPaintingParams.maskImage = args.maskImageBase64;
            }
            else if (args.maskPrompt && args.maskPrompt.trim()) {
                inPaintingParams.maskPrompt = args.maskPrompt.trim();
            }
            return {
                taskType: 'INPAINTING',
                inPaintingParams,
                imageGenerationConfig,
            };
        }
        case 'OUTPAINTING': {
            const outPaintingParams = {
                image: args.sourceImageBase64,
                text: args.prompt?.trim() || '',
            };
            if (args.negativePrompt && args.negativePrompt.trim()) {
                outPaintingParams.negativeText = args.negativePrompt.trim();
            }
            // Mask: either maskPrompt or maskImage (not both)
            if (args.maskImageBase64) {
                outPaintingParams.maskImage = args.maskImageBase64;
            }
            else if (args.maskPrompt && args.maskPrompt.trim()) {
                outPaintingParams.maskPrompt = args.maskPrompt.trim();
            }
            if (args.outpaintingMode) {
                outPaintingParams.outPaintingMode = args.outpaintingMode;
            }
            return {
                taskType: 'OUTPAINTING',
                outPaintingParams,
                imageGenerationConfig,
            };
        }
        case 'IMAGE_VARIATION': {
            const imageVariationParams = {
                images: [args.sourceImageBase64],
            };
            if (args.prompt && args.prompt.trim()) {
                imageVariationParams.text = args.prompt.trim();
            }
            if (args.negativePrompt && args.negativePrompt.trim()) {
                imageVariationParams.negativeText = args.negativePrompt.trim();
            }
            if (args.similarityStrength !== undefined) {
                imageVariationParams.similarityStrength = args.similarityStrength;
            }
            return {
                taskType: 'IMAGE_VARIATION',
                imageVariationParams,
                imageGenerationConfig,
            };
        }
        case 'BACKGROUND_REMOVAL': {
            return {
                taskType: 'BACKGROUND_REMOVAL',
                backgroundRemovalParams: {
                    image: args.sourceImageBase64,
                },
            };
        }
        default:
            throw new Error(`Unsupported image task type: ${args.taskType}`);
    }
}
// Build Claude messages API content for text-only or image+text inputs
function buildClaudeMessageContent(args) {
    const trimmedPrompt = typeof args.prompt === 'string' ? args.prompt : '';
    if (args.inputType !== 'image') {
        return trimmedPrompt;
    }
    if (!args.binary || typeof args.binary.data !== 'string' || !args.binary.data) {
        throw new Error('Missing binary image data for image input.');
    }
    const mediaType = (args.binary.mimeType && args.binary.mimeType.toString().trim()) || 'image/png';
    return [
        {
            type: 'image',
            source: {
                type: 'base64',
                media_type: mediaType,
                data: args.binary.data,
            },
        },
        {
            type: 'text',
            text: trimmedPrompt,
        },
    ];
}
// Helper function: Get cached credentials or fetch new ones
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
// Helper function: Execute AssumeRole
async function assumeRole(credentials) {
    console.log('[AWS Bedrock] Starting AssumeRole process...');
    const fromEnv = (v) => (typeof v === 'string' ? v.trim() : v);
    const accessKeyId = credentials.accessKeyId || fromEnv(process.env.AWS_ACCESS_KEY_ID);
    const secretAccessKey = credentials.secretAccessKey || fromEnv(process.env.AWS_SECRET_ACCESS_KEY);
    const region = credentials.region || fromEnv(process.env.AWS_REGION) || 'us-east-1';
    const roleArn = credentials.roleArn || fromEnv(process.env.AWS_ROLE_ARN);
    console.log('[AWS Bedrock] AssumeRole parameters:', {
        roleArn,
        region,
        durationSeconds: credentials.durationSeconds || 3600,
        credentialSource: accessKeyId && secretAccessKey ? 'explicit' : 'provider-chain',
    });
    // Use explicit credentials if provided, otherwise fall back to the default
    // AWS credential provider chain (ECS task role, instance profile, env vars, etc.)
    const stsCredentials = accessKeyId && secretAccessKey
        ? { accessKeyId, secretAccessKey }
        : (0, credential_providers_1.fromNodeProviderChain)();
    const sts = new client_sts_1.STSClient({
        region: region,
        credentials: stsCredentials,
    });
    try {
        const assumeRoleParams = {
            RoleArn: roleArn,
            RoleSessionName: 'n8n-bedrock-session',
            DurationSeconds: credentials.durationSeconds || 3600,
        };
        if (credentials.externalId) {
            assumeRoleParams.ExternalId = credentials.externalId;
        }
        const result = await sts.send(new client_sts_1.AssumeRoleCommand(assumeRoleParams));
        if (!result.Credentials) {
            throw new Error('Failed to obtain temporary credentials from STS');
        }
        console.log('[AWS Bedrock] AssumeRole successful:', {
            accessKeyIdPrefix: result.Credentials.AccessKeyId.substring(0, 8) + '...',
            expiration: result.Credentials.Expiration,
            expiresIn: Math.floor((new Date(result.Credentials.Expiration).getTime() - new Date().getTime()) / 1000) + 's',
        });
        return result.Credentials;
    }
    catch (error) {
        console.error('[AWS Bedrock] AssumeRole failed:', {
            error: error.message,
            code: error.Code || error.name,
            roleArn,
        });
        throw error;
    }
}
class AwsBedrockAssumeRole {
    constructor() {
        this.description = {
            displayName: 'AWS Bedrock (AssumeRole)',
            name: 'awsBedrockAssumeRole',
            icon: 'file:bedrock.svg',
            group: ['transform'],
            version: 1,
            description: 'Interact with AWS Bedrock using AssumeRole authentication',
            defaults: {
                name: 'AWS Bedrock (AssumeRole)',
            },
            inputs: ['main'],
            outputs: ['main'],
            credentials: [
                {
                    name: 'awsAssumeRole',
                    required: true,
                },
            ],
            properties: [
                {
                    displayName: 'Model ID',
                    name: 'modelId',
                    type: 'options',
                    options: [],
                    typeOptions: {
                        loadOptionsMethod: 'getModelOptions',
                    },
                    default: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
                    required: true,
                    description: 'The model ID to use for the request. When Application Inference Profiles JSON is configured in the credentials, only the models present in that JSON will be listed here.',
                },
                // ===== Text/Chat Model Fields (Claude) =====
                {
                    displayName: 'Input Type',
                    name: 'inputType',
                    type: 'options',
                    options: [
                        {
                            name: 'Text Only',
                            value: 'text',
                        },
                        {
                            name: 'Text and Image',
                            value: 'image',
                        },
                    ],
                    default: 'text',
                    required: true,
                    description: 'Choose whether to send only text or a combination of image and text to the model.',
                    displayOptions: {
                        hide: {
                            modelId: [
                                'amazon.nova-canvas-v1:0',
                                'amazon.titan-image-generator-v2:0',
                            ],
                        },
                    },
                },
                {
                    displayName: 'Image Binary Property',
                    name: 'imageBinaryPropertyName',
                    type: 'string',
                    default: 'data',
                    required: false,
                    description: 'Name of the binary property that contains the image to analyze.',
                    displayOptions: {
                        show: {
                            inputType: ['image'],
                        },
                        hide: {
                            modelId: [
                                'amazon.nova-canvas-v1:0',
                                'amazon.titan-image-generator-v2:0',
                            ],
                        },
                    },
                },
                {
                    displayName: 'Prompt',
                    name: 'prompt',
                    type: 'string',
                    typeOptions: {
                        rows: 4,
                    },
                    default: '',
                    required: true,
                    description: 'The prompt to send to the model',
                },
                {
                    displayName: 'Max Tokens',
                    name: 'maxTokens',
                    type: 'number',
                    default: 1000,
                    required: true,
                    description: 'Maximum number of tokens to generate',
                    displayOptions: {
                        hide: {
                            modelId: [
                                'amazon.nova-canvas-v1:0',
                                'amazon.titan-image-generator-v2:0',
                            ],
                        },
                    },
                },
                {
                    displayName: 'Temperature',
                    name: 'temperature',
                    type: 'number',
                    typeOptions: {
                        minValue: 0,
                        maxValue: 1,
                        numberStepSize: 0.1,
                    },
                    default: 0.7,
                    required: false,
                    description: 'Controls randomness in the response (0.0 to 1.0)',
                    displayOptions: {
                        hide: {
                            modelId: [
                                'amazon.nova-canvas-v1:0',
                                'amazon.titan-image-generator-v2:0',
                            ],
                        },
                    },
                },
                // ===== Image Generation Model Fields (Nova Canvas, Titan Image) =====
                // ===== Image Task Type =====
                {
                    displayName: 'Image Task Type',
                    name: 'imageTaskType',
                    type: 'options',
                    options: [
                        {
                            name: 'Text to Image (Generate)',
                            value: 'TEXT_IMAGE',
                            description: 'Generate a new image from a text prompt',
                        },
                        {
                            name: 'Inpainting (Edit Inside Mask)',
                            value: 'INPAINTING',
                            description: 'Modify areas inside a masked region of an existing image',
                        },
                        {
                            name: 'Outpainting (Edit Outside Mask)',
                            value: 'OUTPAINTING',
                            description: 'Extend or modify areas outside a masked region',
                        },
                        {
                            name: 'Image Variation',
                            value: 'IMAGE_VARIATION',
                            description: 'Create variations of an existing image',
                        },
                        {
                            name: 'Background Removal',
                            value: 'BACKGROUND_REMOVAL',
                            description: 'Remove the background from an image (outputs transparent PNG)',
                        },
                    ],
                    default: 'TEXT_IMAGE',
                    required: true,
                    description: 'Type of image task to perform',
                    displayOptions: {
                        show: {
                            modelId: [
                                'amazon.nova-canvas-v1:0',
                                'amazon.titan-image-generator-v2:0',
                            ],
                        },
                    },
                },
                // ===== Source Image for Editing Tasks =====
                {
                    displayName: 'Source Image Binary Property',
                    name: 'sourceImageBinaryProperty',
                    type: 'string',
                    default: 'data',
                    required: true,
                    description: 'Name of the binary property containing the source image to edit',
                    displayOptions: {
                        show: {
                            modelId: [
                                'amazon.nova-canvas-v1:0',
                                'amazon.titan-image-generator-v2:0',
                            ],
                            imageTaskType: [
                                'INPAINTING',
                                'OUTPAINTING',
                                'IMAGE_VARIATION',
                                'BACKGROUND_REMOVAL',
                            ],
                        },
                    },
                },
                // ===== Mask Prompt (for Inpainting/Outpainting) =====
                {
                    displayName: 'Mask Prompt',
                    name: 'maskPrompt',
                    type: 'string',
                    typeOptions: {
                        rows: 2,
                    },
                    default: '',
                    required: false,
                    description: 'Text description of the area to mask (e.g., "the sky", "the person\'s face"). Either Mask Prompt or Mask Image is required.',
                    displayOptions: {
                        show: {
                            modelId: [
                                'amazon.nova-canvas-v1:0',
                                'amazon.titan-image-generator-v2:0',
                            ],
                            imageTaskType: [
                                'INPAINTING',
                                'OUTPAINTING',
                            ],
                        },
                    },
                },
                // ===== Mask Image Binary Property (optional alternative to Mask Prompt) =====
                {
                    displayName: 'Mask Image Binary Property',
                    name: 'maskImageBinaryProperty',
                    type: 'string',
                    default: '',
                    required: false,
                    description: 'Optional: Name of the binary property containing a black/white mask image. Black pixels = area to modify, White pixels = area to preserve.',
                    displayOptions: {
                        show: {
                            modelId: [
                                'amazon.nova-canvas-v1:0',
                                'amazon.titan-image-generator-v2:0',
                            ],
                            imageTaskType: [
                                'INPAINTING',
                                'OUTPAINTING',
                            ],
                        },
                    },
                },
                // ===== Outpainting Mode =====
                {
                    displayName: 'Outpainting Mode',
                    name: 'outpaintingMode',
                    type: 'options',
                    options: [
                        {
                            name: 'Default',
                            value: 'DEFAULT',
                            description: 'Allow modification of the image inside the mask for consistency',
                        },
                        {
                            name: 'Precise',
                            value: 'PRECISE',
                            description: 'Prevent modification of the image inside the mask',
                        },
                    ],
                    default: 'DEFAULT',
                    required: false,
                    description: 'Controls whether the area inside the mask can be modified for consistency',
                    displayOptions: {
                        show: {
                            modelId: [
                                'amazon.nova-canvas-v1:0',
                                'amazon.titan-image-generator-v2:0',
                            ],
                            imageTaskType: [
                                'OUTPAINTING',
                            ],
                        },
                    },
                },
                // ===== Similarity Strength (for Image Variation) =====
                {
                    displayName: 'Similarity Strength',
                    name: 'similarityStrength',
                    type: 'number',
                    typeOptions: {
                        minValue: 0.2,
                        maxValue: 1.0,
                        numberStepSize: 0.1,
                    },
                    default: 0.7,
                    required: false,
                    description: 'How similar the generated image should be to the input (0.2-1.0). Lower = more variation.',
                    displayOptions: {
                        show: {
                            modelId: [
                                'amazon.nova-canvas-v1:0',
                                'amazon.titan-image-generator-v2:0',
                            ],
                            imageTaskType: [
                                'IMAGE_VARIATION',
                            ],
                        },
                    },
                },
                {
                    displayName: 'Negative Prompt',
                    name: 'negativePrompt',
                    type: 'string',
                    typeOptions: {
                        rows: 2,
                    },
                    default: '',
                    required: false,
                    description: 'Text describing what NOT to include in the generated image (max 512 characters)',
                    displayOptions: {
                        show: {
                            modelId: [
                                'amazon.nova-canvas-v1:0',
                                'amazon.titan-image-generator-v2:0',
                            ],
                            imageTaskType: [
                                'TEXT_IMAGE',
                                'INPAINTING',
                                'OUTPAINTING',
                                'IMAGE_VARIATION',
                            ],
                        },
                    },
                },
                {
                    displayName: 'Image Width',
                    name: 'imageWidth',
                    type: 'options',
                    options: [
                        { name: '512', value: 512 },
                        { name: '768', value: 768 },
                        { name: '1024', value: 1024 },
                        { name: '1280', value: 1280 },
                    ],
                    default: 1024,
                    required: true,
                    description: 'Width of the generated image in pixels',
                    displayOptions: {
                        show: {
                            modelId: [
                                'amazon.nova-canvas-v1:0',
                                'amazon.titan-image-generator-v2:0',
                            ],
                            imageTaskType: [
                                'TEXT_IMAGE',
                                'IMAGE_VARIATION',
                            ],
                        },
                    },
                },
                {
                    displayName: 'Image Height',
                    name: 'imageHeight',
                    type: 'options',
                    options: [
                        { name: '512', value: 512 },
                        { name: '768', value: 768 },
                        { name: '1024', value: 1024 },
                        { name: '1280', value: 1280 },
                    ],
                    default: 1024,
                    required: true,
                    description: 'Height of the generated image in pixels',
                    displayOptions: {
                        show: {
                            modelId: [
                                'amazon.nova-canvas-v1:0',
                                'amazon.titan-image-generator-v2:0',
                            ],
                            imageTaskType: [
                                'TEXT_IMAGE',
                                'IMAGE_VARIATION',
                            ],
                        },
                    },
                },
                {
                    displayName: 'Image Quality',
                    name: 'imageQuality',
                    type: 'options',
                    options: [
                        { name: 'Standard', value: 'standard' },
                        { name: 'Premium', value: 'premium' },
                    ],
                    default: 'standard',
                    required: true,
                    description: 'Quality of the generated image',
                    displayOptions: {
                        show: {
                            modelId: [
                                'amazon.nova-canvas-v1:0',
                                'amazon.titan-image-generator-v2:0',
                            ],
                        },
                    },
                },
                {
                    displayName: 'Number of Images',
                    name: 'numberOfImages',
                    type: 'number',
                    typeOptions: {
                        minValue: 1,
                        maxValue: 4,
                    },
                    default: 1,
                    required: true,
                    description: 'Number of images to generate (1-4)',
                    displayOptions: {
                        show: {
                            modelId: [
                                'amazon.nova-canvas-v1:0',
                                'amazon.titan-image-generator-v2:0',
                            ],
                        },
                    },
                },
                {
                    displayName: 'Seed',
                    name: 'imageSeed',
                    type: 'number',
                    default: 0,
                    required: false,
                    description: 'Seed for reproducible image generation (0 for random). Range: 0 to 858993459.',
                    displayOptions: {
                        show: {
                            modelId: [
                                'amazon.nova-canvas-v1:0',
                                'amazon.titan-image-generator-v2:0',
                            ],
                        },
                    },
                },
                {
                    displayName: 'CFG Scale',
                    name: 'cfgScale',
                    type: 'number',
                    typeOptions: {
                        minValue: 1,
                        maxValue: 15,
                        numberStepSize: 0.5,
                    },
                    default: 8.0,
                    required: false,
                    description: 'How closely the image follows the prompt (1-15). Higher values = more literal interpretation.',
                    displayOptions: {
                        show: {
                            modelId: [
                                'amazon.titan-image-generator-v2:0',
                            ],
                        },
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
                        {
                            name: 'Amazon Nova Canvas v1 (Image Generation)',
                            value: 'amazon.nova-canvas-v1:0',
                        },
                        {
                            name: 'Amazon Titan Image Generator v2',
                            value: 'amazon.titan-image-generator-v2:0',
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
                        profilesContainer = buildApplicationInferenceProfilesFromJson(jsonText);
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
                        if (options.some((option) => option.value === modelId)) {
                            continue;
                        }
                        const name = labelByModelId[modelId] || modelId;
                        options.push({
                            name,
                            value: modelId,
                        });
                    }
                    if (options.length === 0) {
                        return staticOptions;
                    }
                    return options;
                },
            },
        };
    }
    async execute() {
        const items = this.getInputData();
        const returnData = [];
        for (let i = 0; i < items.length; i++) {
            try {
                console.log(`[AWS Bedrock] Processing item ${i + 1}/${items.length}`);
                // Get credential data
                const rawCreds = await this.getCredentials('awsAssumeRole');
                console.log('[AWS Bedrock] Credentials loaded from n8n');
                const resolved = resolveBase(rawCreds);
                // Get node parameters
                const configuredModelId = this.getNodeParameter('modelId', i);
                const prompt = this.getNodeParameter('prompt', i);
                const isImageModel = isImageGenerationModel(configuredModelId);
                // Get parameters based on model type
                let inputType = 'text';
                let maxTokens = 1000;
                let temperature = 0.7;
                let imageBinaryPropertyName;
                // Image generation parameters
                let imageWidth = 1024;
                let imageHeight = 1024;
                let imageQuality = 'standard';
                let numberOfImages = 1;
                let imageSeed = 0;
                let negativePrompt = '';
                let cfgScale = 8.0;
                // Image editing parameters
                let imageTaskType = 'TEXT_IMAGE';
                let sourceImageBase64;
                let maskPrompt;
                let maskImageBase64;
                let outpaintingMode = 'DEFAULT';
                let similarityStrength;
                if (isImageModel) {
                    // Get image task type
                    imageTaskType = this.getNodeParameter('imageTaskType', i, 'TEXT_IMAGE');
                    // Get image generation parameters
                    // Only get width/height for tasks that need them (TEXT_IMAGE, IMAGE_VARIATION)
                    const tasksRequiringDimensions = ['TEXT_IMAGE', 'IMAGE_VARIATION'];
                    if (tasksRequiringDimensions.includes(imageTaskType)) {
                        imageWidth = this.getNodeParameter('imageWidth', i);
                        imageHeight = this.getNodeParameter('imageHeight', i);
                    }
                    imageQuality = this.getNodeParameter('imageQuality', i);
                    numberOfImages = this.getNodeParameter('numberOfImages', i);
                    imageSeed = this.getNodeParameter('imageSeed', i, 0);
                    negativePrompt = this.getNodeParameter('negativePrompt', i, '');
                    if (configuredModelId.includes('titan-image')) {
                        cfgScale = this.getNodeParameter('cfgScale', i, 8.0);
                    }
                    // Get source image for editing tasks
                    const editingTasks = ['INPAINTING', 'OUTPAINTING', 'IMAGE_VARIATION', 'BACKGROUND_REMOVAL'];
                    if (editingTasks.includes(imageTaskType)) {
                        const sourceImageBinaryProperty = this.getNodeParameter('sourceImageBinaryProperty', i, 'data');
                        const item = items[i];
                        if (!item.binary || !item.binary[sourceImageBinaryProperty]) {
                            throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Binary property "${sourceImageBinaryProperty}" with source image is missing. Please provide an image to edit.`);
                        }
                        const binaryData = item.binary[sourceImageBinaryProperty];
                        // Use getBinaryDataBuffer to properly retrieve binary data (handles filesystem storage)
                        const binaryBuffer = await this.helpers.getBinaryDataBuffer(i, sourceImageBinaryProperty);
                        sourceImageBase64 = binaryBuffer.toString('base64');
                        // Validate MIME type - Nova Canvas and Titan Image only support PNG and JPEG
                        let detectedMimeType = binaryData.mimeType || 'application/octet-stream';
                        // If MIME type is not detected, try to detect from magic bytes
                        if (detectedMimeType === 'application/octet-stream' && binaryBuffer.length > 4) {
                            if (binaryBuffer[0] === 0xFF && binaryBuffer[1] === 0xD8 && binaryBuffer[2] === 0xFF) {
                                detectedMimeType = 'image/jpeg';
                            }
                            else if (binaryBuffer[0] === 0x89 && binaryBuffer[1] === 0x50 && binaryBuffer[2] === 0x4E && binaryBuffer[3] === 0x47) {
                                detectedMimeType = 'image/png';
                            }
                        }
                        const supportedImageTypes = ['image/png', 'image/jpeg', 'image/jpg'];
                        if (!supportedImageTypes.includes(detectedMimeType)) {
                            throw new n8n_workflow_1.NodeOperationError(this.getNode(), `The detected file MIME type "${detectedMimeType}" is not supported by this model. Supported types: PNG, JPEG. Try converting your image to PNG or JPEG format.`);
                        }
                        console.log('[AWS Bedrock] Source image validated:', {
                            originalMimeType: binaryData.mimeType,
                            detectedMimeType,
                            bufferLength: binaryBuffer.length,
                            base64Length: sourceImageBase64.length,
                        });
                    }
                    // Get mask parameters for inpainting/outpainting
                    if (imageTaskType === 'INPAINTING' || imageTaskType === 'OUTPAINTING') {
                        maskPrompt = this.getNodeParameter('maskPrompt', i, '');
                        const maskImageBinaryProperty = this.getNodeParameter('maskImageBinaryProperty', i, '');
                        if (maskImageBinaryProperty) {
                            const item = items[i];
                            if (item.binary && item.binary[maskImageBinaryProperty]) {
                                // Use getBinaryDataBuffer to properly retrieve binary data
                                const maskBuffer = await this.helpers.getBinaryDataBuffer(i, maskImageBinaryProperty);
                                maskImageBase64 = maskBuffer.toString('base64');
                            }
                        }
                        // Validate that at least one mask method is provided
                        if (!maskPrompt && !maskImageBase64) {
                            throw new n8n_workflow_1.NodeOperationError(this.getNode(), 'Either Mask Prompt or Mask Image must be provided for inpainting/outpainting tasks.');
                        }
                    }
                    // Get outpainting mode
                    if (imageTaskType === 'OUTPAINTING') {
                        outpaintingMode = this.getNodeParameter('outpaintingMode', i, 'DEFAULT');
                    }
                    // Get similarity strength for image variation
                    if (imageTaskType === 'IMAGE_VARIATION') {
                        similarityStrength = this.getNodeParameter('similarityStrength', i, 0.7);
                    }
                    console.log('[AWS Bedrock] Image generation parameters:', {
                        configuredModelId,
                        imageTaskType,
                        promptLength: prompt.length,
                        imageWidth,
                        imageHeight,
                        imageQuality,
                        numberOfImages,
                        imageSeed,
                        negativePromptLength: negativePrompt.length,
                        cfgScale,
                        hasSourceImage: !!sourceImageBase64,
                        maskPromptLength: maskPrompt?.length || 0,
                        hasMaskImage: !!maskImageBase64,
                        outpaintingMode,
                        similarityStrength,
                    });
                }
                else {
                    // Get text/chat model parameters
                    inputType = this.getNodeParameter('inputType', i);
                    maxTokens = this.getNodeParameter('maxTokens', i);
                    temperature = this.getNodeParameter('temperature', i);
                    imageBinaryPropertyName =
                        inputType === 'image'
                            ? this.getNodeParameter('imageBinaryPropertyName', i)
                            : undefined;
                    console.log('[AWS Bedrock] Text model parameters:', {
                        configuredModelId,
                        inputType,
                        imageBinaryPropertyName,
                        promptLength: prompt.length,
                        maxTokens,
                        temperature,
                    });
                }
                // Resolve effective model identifier (optionally using application inference profile)
                const rawCredsRecord = rawCreds;
                const applicationInferenceProfileAccountId = rawCredsRecord.applicationInferenceProfileAccountId;
                const applicationInferenceProfileId = rawCredsRecord.applicationInferenceProfileId;
                const applicationInferenceProfilesJson = rawCredsRecord.applicationInferenceProfilesJson;
                let applicationInferenceProfiles = rawCredsRecord.applicationInferenceProfiles;
                if (!applicationInferenceProfiles && applicationInferenceProfilesJson) {
                    applicationInferenceProfiles = buildApplicationInferenceProfilesFromJson(applicationInferenceProfilesJson);
                }
                const effectiveModelId = resolveEffectiveModelId({
                    modelId: configuredModelId,
                    region: resolved.region,
                    applicationInferenceProfileAccountId,
                    applicationInferenceProfileId,
                    applicationInferenceProfiles,
                });
                console.log('[AWS Bedrock] Resolved model identifier:', {
                    configuredModelId,
                    effectiveModelId,
                });
                // Get temporary credentials via AssumeRole
                const tempCreds = await getCachedOrFetchCredentials(resolved);
                // Create Bedrock client with temporary credentials
                const bedrockClient = new client_bedrock_runtime_1.BedrockRuntimeClient({
                    region: resolved.region,
                    credentials: {
                        accessKeyId: tempCreds.AccessKeyId,
                        secretAccessKey: tempCreds.SecretAccessKey,
                        sessionToken: tempCreds.SessionToken,
                    },
                });
                // Prepare the request body based on the configured model
                let requestBody;
                if (isImageModel) {
                    // Build request body for image generation models
                    requestBody = buildImageGenerationRequestBody({
                        modelId: configuredModelId,
                        taskType: imageTaskType,
                        prompt,
                        negativePrompt,
                        width: imageWidth,
                        height: imageHeight,
                        quality: imageQuality,
                        numberOfImages,
                        seed: imageSeed,
                        cfgScale,
                        // Editing task parameters
                        sourceImageBase64,
                        maskPrompt,
                        maskImageBase64,
                        outpaintingMode,
                        similarityStrength,
                    });
                }
                else if (configuredModelId.includes('anthropic.claude')) {
                    // Build request body for Claude models
                    let messageContent;
                    if (inputType === 'image') {
                        if (!imageBinaryPropertyName) {
                            throw new n8n_workflow_1.NodeOperationError(this.getNode(), 'Image binary property name must be set when input type is "Text and Image".');
                        }
                        const item = items[i];
                        if (!item.binary || !item.binary[imageBinaryPropertyName]) {
                            throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Binary property "${imageBinaryPropertyName}" with image data is missing on item.`);
                        }
                        const binaryData = item.binary[imageBinaryPropertyName];
                        // Use getBinaryDataBuffer to properly retrieve binary data (handles filesystem storage)
                        const imageBuffer = await this.helpers.getBinaryDataBuffer(i, imageBinaryPropertyName);
                        const imageBase64 = imageBuffer.toString('base64');
                        messageContent = buildClaudeMessageContent({
                            inputType,
                            prompt,
                            binary: {
                                data: imageBase64,
                                mimeType: binaryData.mimeType,
                            },
                        });
                    }
                    else {
                        messageContent = buildClaudeMessageContent({
                            inputType: 'text',
                            prompt,
                        });
                    }
                    requestBody = {
                        anthropic_version: 'bedrock-2023-05-31',
                        max_tokens: maxTokens,
                        messages: [
                            {
                                role: 'user',
                                content: messageContent,
                            },
                        ],
                    };
                    if (temperature !== undefined) {
                        requestBody.temperature = temperature;
                    }
                }
                else {
                    throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Unsupported model: ${configuredModelId}`);
                }
                console.log('[AWS Bedrock] Invoking model:', {
                    configuredModelId,
                    effectiveModelId,
                    requestBodyKeys: Object.keys(requestBody),
                });
                // Invoke the model
                const command = new client_bedrock_runtime_1.InvokeModelCommand({
                    modelId: effectiveModelId,
                    body: JSON.stringify(requestBody),
                    contentType: 'application/json',
                    accept: 'application/json',
                });
                const response = await bedrockClient.send(command);
                // Parse the response
                const responseBody = JSON.parse(new TextDecoder().decode(response.body));
                // Handle response based on model type
                if (isImageModel) {
                    // Image generation response
                    const images = responseBody.images;
                    console.log('[AWS Bedrock] Image generation response received:', {
                        numberOfImages: images?.length || 0,
                        error: responseBody.error || null,
                    });
                    if (responseBody.error) {
                        throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Image generation failed: ${responseBody.error}`);
                    }
                    if (!images || images.length === 0) {
                        throw new n8n_workflow_1.NodeOperationError(this.getNode(), 'No images were generated by the model.');
                    }
                    // Create output for each generated image
                    for (let imgIndex = 0; imgIndex < images.length; imgIndex++) {
                        const base64Image = images[imgIndex];
                        const binaryData = Buffer.from(base64Image, 'base64');
                        const outputData = {
                            json: {
                                modelId: effectiveModelId,
                                configuredModelId,
                                prompt,
                                imageIndex: imgIndex,
                                totalImages: images.length,
                                imageWidth,
                                imageHeight,
                                imageQuality,
                                timestamp: new Date().toISOString(),
                            },
                            binary: {
                                data: {
                                    data: base64Image,
                                    mimeType: 'image/png',
                                    fileName: `generated-image-${imgIndex + 1}.png`,
                                    fileSize: binaryData.length.toString(),
                                    fileExtension: 'png',
                                },
                            },
                        };
                        returnData.push(outputData);
                    }
                }
                else {
                    // Text/chat model response (Claude)
                    console.log('[AWS Bedrock] Model response received:', {
                        usage: responseBody.usage || 'N/A',
                        contentLength: responseBody.content?.[0]?.text?.length || 0,
                    });
                    // Format the output
                    const outputData = {
                        json: {
                            modelId: effectiveModelId,
                            configuredModelId,
                            prompt,
                            response: responseBody,
                            usage: responseBody.usage,
                            content: responseBody.content?.[0]?.text || responseBody.completion || '',
                            timestamp: new Date().toISOString(),
                        },
                    };
                    returnData.push(outputData);
                }
            }
            catch (error) {
                console.error('[AWS Bedrock] Error processing item:', {
                    itemIndex: i,
                    error: error.message,
                    code: error.Code || error.name,
                });
                if (this.continueOnFail()) {
                    returnData.push({
                        json: {
                            error: error.message,
                            itemIndex: i,
                        },
                    });
                }
                else {
                    throw new n8n_workflow_1.NodeOperationError(this.getNode(), error.message);
                }
            }
        }
        return [returnData];
    }
}
exports.AwsBedrockAssumeRole = AwsBedrockAssumeRole;
