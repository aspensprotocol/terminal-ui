# Enable colors
autoload -U colors && colors

# Set prompt
PROMPT='%F{cyan}%n@%m%f:%F{yellow}%~%f$ '

# History settings
HISTSIZE=10000
SAVEHIST=10000
HISTFILE=~/.zsh_history

# Basic completions
autoload -Uz compinit
compinit

# Aliases
alias ll='ls -lah'
alias la='ls -A'
alias l='ls -CF'
alias gs='git status'
alias gd='git diff'
alias gc='git commit'
alias gp='git push'
alias gl='git log --oneline --graph'

# Project-specific aliases
alias backend='cd /workspace && just backend'
alias frontend='cd /workspace && just frontend'
alias db-setup='cd /workspace && just db-setup'
alias db-reset='cd /workspace && just db-reset'

# Add cargo binaries to PATH
export PATH="$HOME/.cargo/bin:$PATH"

# Welcome message
echo ""
echo "🚀 Welcome to the Cryptocurrency Exchange development environment!"
echo ""
echo "Quick commands:"
echo "  backend   - Start the backend server"
echo "  frontend  - Start the frontend dev server"
echo "  just --list - See all available commands"
echo ""
