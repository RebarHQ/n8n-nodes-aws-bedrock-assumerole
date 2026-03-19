import type { INodeType, INodeTypeDescription, ISupplyDataFunctions, SupplyData, ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';
export declare class AwsBedrockChatModel implements INodeType {
    description: INodeTypeDescription;
    methods: {
        loadOptions: {
            getModelOptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]>;
        };
    };
    supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData>;
}
