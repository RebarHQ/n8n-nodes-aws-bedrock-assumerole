# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.4] - 2026-03-09

### Fixed
- Move n8n-workflow from dependencies to peerDependencies to fix "installed with error" in n8n UI caused by dual n8n-workflow instances


## [1.6.3] - 2026-01-08

### Fixed
- bug on image buffering


## [1.6.2] - 2026-01-08


## [1.6.1] - 2026-01-08


## [1.6.0] - 2026-01-08

### Added
- image generation: support for image as input of prompt


## [1.5.0] - 2026-01-08

### Added
- **Image Generation Support**: Added support for Amazon Nova Canvas v1 and Amazon Titan Image Generator v2 models
- New image generation parameters with conditional UI fields:
  - Image Width (512, 768, 1024, 1280)
  - Image Height (512, 768, 1024, 1280)
  - Image Quality (standard/premium)
  - Number of Images (1-4)
  - Seed for reproducible generation
  - Negative Prompt (what NOT to include in the image)
  - CFG Scale (Titan Image only) - controls how closely the image follows the prompt
- Generated images are returned as binary data, ready for saving or further processing
- New helper functions: `isImageGenerationModel()`, `buildImageGenerationRequestBody()`
- 11 new unit tests for image generation functionality

### Changed
- Text model parameters (Max Tokens, Temperature, Input Type) are now hidden when an image generation model is selected
- Model dropdown now includes image generation models alongside Claude models

## [1.3.4] - 2025-12-29

### Fixed
- Fix @langchain/core dependency issue

## [1.3.3] - 2024-12-29

### Fixed
- Move @langchain/core from dependencies to peerDependencies to prevent installation conflicts with n8n's built-in @langchain/core

## [1.3.2] - 2025-11-19

### Fixed
- Fix message type detection using `_getType()` method instead of `instanceof` to handle cross-version compatibility issues with LangChain
- Resolve "messages: at least one message is required" error caused by message type detection failure

## [1.3.1] - 2025-11-19

### Fixed
- Add validation and descriptive error message when AI Agent sends empty messages array to prevent "messages: at least one message is required" error from AWS Bedrock API

## [1.3.0] - 2025-11-18

### Added
- sub-node to generate a chat model compatible with AI Agent


## [1.2.0] - 2025-11-18

### Added
- Optional image input support (Text and Image) with new helper and example workflow. Backwards compatible for existing text-only workflows.


## [1.1.0] - 2025-11-14

### Added
- Now Application Inference profiles are configurable from credential


## [1.0.6] - 2025-11-13

### Fixed
- model name checker


## [1.0.5] - 2025-11-13

### Fixed
- fix inferenced models nomeclature


## [1.0.4] - 2025-11-13

### Changed
- icons to modern ones on the folder

### Removed
- not used code


## [1.0.2] - 2024-11-13

### Fixed
- Fixed custom SVG icons not displaying correctly in n8n UI
- Icons now properly located in `dist/nodes/` and `dist/credentials/` directories
- Removed redundant `dist/icons/` directory

### Changed
- Updated icon references to use `file:bedrock.svg` and `file:aws.svg`
- Optimized build script to copy icons to correct locations

### Removed
- Removed unused `authenticate` and `test` properties from credentials
- Removed unused imports (`IAuthenticateGeneric`, `ICredentialTestRequest`)
- Cleaned up dead code and redundant files

## [1.0.1] - 2024-11-12

### Fixed
- Minor bug fixes and improvements

## [1.0.0] - 2024-11-12

### Added
- Initial release of n8n-nodes-aws-bedrock-assumerole
- AWS Bedrock integration with AssumeRole authentication
- Support for multiple Claude models:
  - Claude 3.5 Sonnet (v2 & v1)
  - Claude 3 Opus
  - Claude 3 Sonnet
  - Claude 3 Haiku
  - Claude 2.1
  - Claude 2.0
  - Claude Instant 1.2
- Automatic credential caching with expiration handling
- Comprehensive error handling and logging
- Batch processing support for multiple items
- Usage tracking and response metadata
- TypeScript implementation with full type safety
- Complete documentation and examples
- Installation script for easy setup

### Features
- 🔐 Secure cross-account access using AWS STS AssumeRole
- ⚡ Credential caching to minimize STS calls
- 🛡️ Comprehensive error handling
- 📊 Detailed usage information and response metadata
- 🔄 Support for processing multiple items in a single execution
- 🎨 Custom SVG icons for better visual identification

### Security
- Environment variable support for AWS credentials
- Secure credential handling with AssumeRole pattern
- No hardcoded credentials in the codebase
- Proper session token management
