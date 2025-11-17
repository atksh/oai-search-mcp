.PHONY: help install build clean test lint format check release

# Default target
help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

# Development Environment Setup
install: ## Install dependencies
	@echo "Installing dependencies..."
	@pnpm install
	@echo "Dependencies installed successfully."

# Build Operations
build: ## Build the project (TypeScript compilation and file copying)
	@echo "Building project..."
	@pnpm run build
	@echo "Build completed successfully."

clean: ## Remove build artifacts
	@echo "Cleaning build directory..."
	@rm -rf build/
	@echo "Clean completed successfully."

rebuild: clean build ## Clean and rebuild the project

# Code Quality
lint: ## Run linter (if configured)
	@echo "Linting code..."
	@if [ -f "node_modules/.bin/eslint" ]; then \
		pnpm run lint; \
	else \
		echo "No linter configured. Skipping..."; \
	fi

format: ## Format code (if configured)
	@echo "Formatting code..."
	@if [ -f "node_modules/.bin/prettier" ]; then \
		pnpm run format; \
	else \
		echo "No formatter configured. Skipping..."; \
	fi

check: build ## Verify build is successful and artifacts exist
	@echo "Checking build artifacts..."
	@test -f build/index.js || (echo "Error: build/index.js not found" && exit 1)
	@test -f build/SYSTEM_PROMPT.md || (echo "Error: build/SYSTEM_PROMPT.md not found" && exit 1)
	@echo "Build verification successful."

# Testing (placeholder for future tests)
test: ## Run tests (placeholder)
	@echo "No tests configured yet."

# Release Management
release: check ## Prepare for release (build, check, and verify)
	@echo "Preparing release..."
	@echo "Version: $$(node -p "require('./package.json').version")"
	@echo "Release preparation completed."

# Development Workflow
dev: install build ## Set up development environment and build

# Verification
verify: install build check ## Full verification pipeline (install, build, check)
	@echo "Full verification completed successfully."

# Git hooks (placeholder for future implementation)
hooks: ## Set up git hooks (placeholder)
	@echo "Git hooks not configured yet."

# Package Publishing (placeholder)
publish: verify ## Publish to npm (requires authentication)
	@echo "Publishing to npm..."
	@pnpm publish
	@echo "Published successfully."

publish-dry-run: verify ## Dry run of npm publish
	@echo "Performing dry run of npm publish..."
	@pnpm publish --dry-run
	@echo "Dry run completed."

