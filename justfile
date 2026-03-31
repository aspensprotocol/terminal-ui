default:
  just --list

dev:
  just ui

ui:
  bun run dev

install:
  bun install

build:
  bun run build

build-sdk:
  bun run build:sdk

fmt:
  bun run format

lint:
  bun run lint

typecheck:
  bun run typecheck

clean:
  bun run clean

ci:
  just install
  just build-sdk
  just fmt
  just lint
  just typecheck
