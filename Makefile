.PHONY: install build image help run check verify

install:
	bun install

build:
	bun run build

image:
	@test -n "$(CHATGPT_DEB)" || (echo "Usage: make image CHATGPT_DEB=/absolute/path/to/chatgpt-linux.deb" >&2; exit 64)
	./scripts/build-container.sh "$(CHATGPT_DEB)"

help:
	bun run src/cli.ts help

run:
	bun run src/cli.ts serve

check:
	bunx tsc --noEmit

verify: check build
