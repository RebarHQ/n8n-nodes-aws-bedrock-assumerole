import { IExecuteFunctions, ILoadOptionsFunctions, INodeExecutionData, INodePropertyOptions, INodeType, INodeTypeDescription } from 'n8n-workflow';
export declare function resolveEffectiveModelId(params: {
    modelId: string;
    region: string;
    applicationInferenceProfileAccountId?: string;
    applicationInferenceProfileId?: string;
    applicationInferenceProfiles?: unknown;
}): string;
export declare function buildApplicationInferenceProfilesFromJson(jsonText?: string): {
    profiles?: Array<{
        modelId?: string;
        profileId?: string;
    }>;
} | undefined;
export declare function isImageGenerationModel(modelId: string): boolean;
export type ImageTaskType = 'TEXT_IMAGE' | 'INPAINTING' | 'OUTPAINTING' | 'IMAGE_VARIATION' | 'BACKGROUND_REMOVAL';
export declare function buildImageGenerationRequestBody(args: {
    modelId: string;
    taskType: ImageTaskType;
    prompt: string;
    negativePrompt?: string;
    width?: number;
    height?: number;
    quality: 'standard' | 'premium';
    numberOfImages: number;
    seed?: number;
    cfgScale?: number;
    sourceImageBase64?: string;
    maskPrompt?: string;
    maskImageBase64?: string;
    outpaintingMode?: 'DEFAULT' | 'PRECISE';
    similarityStrength?: number;
}): Record<string, unknown>;
export declare function buildClaudeMessageContent(args: {
    inputType: 'text' | 'image';
    prompt: string;
    binary?: {
        data?: string;
        mimeType?: string;
    };
}): string | Array<{
    type: string;
    [key: string]: any;
}>;
export declare class AwsBedrockAssumeRole implements INodeType {
    description: INodeTypeDescription;
    methods: {
        loadOptions: {
            getModelOptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]>;
        };
    };
    execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]>;
}
