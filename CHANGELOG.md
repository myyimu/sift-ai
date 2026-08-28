# Changelog

All notable public-facing changes will be documented in this file.

The project is currently pre-release and may change without compatibility
guarantees.

## [Unreleased]

### Added

- Apache-2.0 project license and third-party notice inventory.
- English and Simplified Chinese public README files.
- Security, privacy, contribution, and community guidance.
- Windows CI, dependency update configuration, and secret-scanning policy.
- Evidence/source cards with revalidated return-to-page links.
- Native Host status leases and precise capture failure labels.
- Local, content-free internal demo metrics.
- URL-grouped snapshot history for SPA soft navigation.

### Security

- Upgraded Electron 33.4.11 to 44.0.0 and electron-builder 25.1.8 to 26.15.3.
- Removed the repository-wide third-party Electron download mirror; upstream
  sources are now the default and restricted-network mirrors are local opt-in.
- Added full-history and working-tree Gitleaks policy with narrow exceptions for
  synthetic redaction fixtures and the Chrome manifest public key.

### Known limitations

- Distribution remains an unsigned Windows directory build with an unpacked
  extension and manual Native Host registration.
- Only public, non-sensitive, text-oriented main-frame pages are in scope.
