# Studio Testing Context

Shared terminology for Studio testing and worktree isolation.

## Language

**Worktree Test Isolation (WTI)**:
Functional isolation of Studio test runs, where each invocation uses its own worktree build, plugin artifacts, Studio instances, and test state. This is not full machine isolation: runs may share the host, dedicated test profile (including profile-wide plugin preferences), and Studio installation.
_Avoid_: VM isolation, full machine isolation, worktree sandbox
