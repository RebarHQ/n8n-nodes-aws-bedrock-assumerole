"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AwsAssumeRole = void 0;
class AwsAssumeRole {
    constructor() {
        this.name = 'awsAssumeRole';
        this.displayName = 'AWS Assume Role';
        this.documentationUrl = 'https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html';
        this.icon = 'file:aws.svg';
        this.properties = [
            {
                displayName: 'Access Key ID',
                name: 'accessKeyId',
                type: 'string',
                typeOptions: { password: true },
                default: '',
                required: false,
                placeholder: 'Leave empty (uses server environment variable by default)',
                description: 'Leave empty to use the server AWS_ACCESS_KEY_ID environment variable (recommended). Only fill if you need to use different credentials.',
            },
            {
                displayName: 'Secret Access Key',
                name: 'secretAccessKey',
                type: 'string',
                typeOptions: { password: true },
                default: '',
                required: false,
                placeholder: 'Leave empty (uses server environment variable by default)',
                description: 'Leave empty to use the server AWS_SECRET_ACCESS_KEY environment variable (recommended). Only fill if you need to use different credentials.',
            },
            {
                displayName: 'Role ARN to Assume',
                name: 'roleArn',
                type: 'string',
                default: '',
                required: true,
                placeholder: 'arn:aws:iam::<account-id>:role/<role-name>',
                description: 'Role ARN to assume in the target account',
            },
            {
                displayName: 'AWS Region',
                name: 'region',
                type: 'string',
                default: 'us-east-1',
                required: false,
                placeholder: 'us-east-1',
                description: 'AWS region for the STS and Bedrock services',
            },
            {
                displayName: 'Session Duration (seconds)',
                name: 'durationSeconds',
                type: 'number',
                default: 3600,
                required: false,
                description: 'Duration of the assumed role session in seconds (default: 3600 = 1 hour)',
            },
            {
                displayName: 'Application Inference Profile Account ID',
                name: 'applicationInferenceProfileAccountId',
                type: 'string',
                default: '',
                required: false,
                placeholder: '616474819159',
                description: 'AWS account ID that owns the application inference profiles (optional). If not set, standard model IDs will be used.',
            },
            {
                displayName: 'Application Inference Profiles JSON',
                name: 'applicationInferenceProfilesJson',
                type: 'string',
                default: '',
                required: false,
                typeOptions: {
                    rows: 4,
                },
                placeholder: '{"us.anthropic.claude-3-5-sonnet-20241022-v2:0": "0xumpou8xusv"}',
                description: 'Optional JSON mapping from model IDs to application inference profile IDs. Keys must be model IDs (for example, us.anthropic.claude-3-5-sonnet-20241022-v2:0) and values must be the corresponding profile IDs. If empty or invalid, standard model IDs will be used.',
            },
        ];
    }
}
exports.AwsAssumeRole = AwsAssumeRole;
