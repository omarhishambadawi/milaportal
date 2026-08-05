# MilaServ Portal AI Guide

## Project

This repository contains the MilaServ Portal.

Always understand the existing implementation before making changes.

## General Rules

- Reuse existing code whenever possible.
- Never duplicate business logic.
- Keep TypeScript strict.
- Respect existing architecture.
- Never weaken authentication, RBAC or Supabase RLS.
- Keep UI/UX consistent with the existing design system.
- Make the smallest safe change.
- Build successfully before committing.

## Documentation

The file `docs/project.md` is the project's single source of truth.

If your work changes:

- Architecture
- Database
- Routes
- Components
- Business logic
- Authentication
- RBAC
- Modules

Update `docs/project.md` before finishing.

## Git

- Use the current branch.
- Do not create new branches unless explicitly requested.
- Commit only after successful validation.
- Use clear commit messages.
