# Changelog

<p align="center">
  <img src="https://img.shields.io/badge/Format-Keep%20a%20Changelog-blue.svg" alt="Keep a Changelog">
  <img src="https://img.shields.io/badge/Versioning-SemVer%202.0.0-green.svg" alt="Semantic Versioning">
  <img src="https://img.shields.io/badge/License-MIT-purple.svg" alt="License MIT">
</p>

---

## Acerca de este Changelog

Todos los cambios notables en **Vortex (AST-Driven Predictive CI, Symbol-Level
Barrel Pruner & LPT Test Splitter)** son documentados en este archivo.

Este proyecto se adhiere a:

- **Formato:** [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/)
- **Versionado:** [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

### Categorías de Cambios

- **Added** ✨ - Nuevas características o funcionalidades
- **Changed** 🔄 - Cambios en funcionalidades existentes
- **Fixed** 🐛 - Correcciones de errores
- **Security** 🔒 - Mejoras de seguridad y protección AppSec / Zero-Trust

---

## [Unreleased]

### 💡 Planned

- Soporte opcional de gramáticas WASM (Tree-sitter) para granularidad AST en C++ y
  Java.
- Exportación de trazas OpenTelemetry (OTLP) para observabilidad distribuida de
  pipelines CI/CD.

---

## [1.1.0] - 2026-11-01

**Nombre del Release:** "Enterprise Symbol-Level Barrel Pruning, EWMA Learning &
Zero-Trust AppSec"\
**Tipo de Release:** Minor Feature & Security Hardening Release

### ✨ Added

#### Podado AST de Precisión & Monorepos

- **Podado de _Barrel Files_ a Nivel de Símbolo (`src/ast/analyzer.ts`,
  `src/graph/dag.ts`):** Extracción de bindings de importación nominales
  (`extractImportBindings`) y propagación de punto fijo de llamadas intra-módulo
  (`expandIntraModuleMutatedSymbols`), descartando aristas del grafo cuando un
  consumidor solo importa símbolos no modificados.
- **Resolución Nativa de Monorepos y _Path Aliases_ (`loadWorkspacePathAliases`):**
  Resolución automática de alias configurados en `deno.json` (`imports`) y
  `tsconfig.json` (`compilerOptions.paths` + `baseUrl`).

#### Aprendizaje Predictivo EWMA & Ordenamiento Fail-Fast

- **Auto-Aprendizaje de Telemetría EWMA (`src/scheduler/lpt-splitter.ts`):**
  Soporte para ingesta de reportes **JUnit XML** y **JSON**
  (`--update-telemetry`), actualizando duraciones y tasas de inestabilidad
  (`flakinessRate`) en `.vortex/telemetry.json` mediante Media Móvil Exponencial
  Ponderada ($\alpha = 0.3$).
- **Priorización _Fail-Fast_ Intra-Shard (`computeFailFastPriorityScore`):**
  Reordenamiento interno de cada shard generado por LPT priorizando menor
  distancia en el DAG (`depth = 0` o `1`), propensión de fallo y menor duración
  para fallar en los primeros segundos ante regresiones.

#### Gobernanza, Anotaciones en PR & Puente DevSecOps con Nemesis

- **Anotaciones Nativas y Comentario Sticky en PR
  (`src/reporters/finops-reporter.ts`):** Emisión de comandos nativos de GitHub
  Actions (`::notice`, `::warning`, `::error`) sobre líneas exactas del diff y
  actualización idempotente de comentario resumen en Pull Requests
  (`post-pr-comment`).
- **_Blast-Radius Gatekeeper_ y Trazabilidad de Tickets
  (`src/governance/gatekeeper.ts`):** Extracción automática de claves de
  Jira/Linear/GitHub Issues (`GLS-402`, `PROJ-123`, `#42`), control de umbral
  `max-blast-radius` y exportación de `nemesis-target-files` para auditoría
  quirúrgica con [`glastor-core/nemesis`](https://github.com/glastor-core/nemesis).

### 🔒 Security

- **Guardias AppSec Zero-Trust (`src/security.ts`):**
  - Prevención de **CWE-88** (_Git Argument Injection_) mediante `isValidGitRef`
    y delimitador `--` en `git diff`.
  - Contención léxica estricta contra **CWE-22** (_Path Traversal_) mediante
    `resolveSafeWorkspacePath` e `isSafeRelativeFilePath`.
  - Escapado oficial contra **CWE-78 / CWE-93** (_Workflow Command & Output
    Injection_) mediante `escapeWorkflowCommandData`,
    `escapeWorkflowCommandProperty` y `sanitizeGitHubOutputValue`.
  - Protección contra **CWE-918** (_SSRF_) y DoS mediante validación `https://`
    en `isSafeGitHubApiUrl` y `AbortSignal.timeout(5000)`.
- **Endurecimiento de Workflows CI/CD (`.github/workflows/ci.yml`,
  `auto-version.yml`):** Eliminación de interpolación inline `${{ ... }}` en
  bloques `run:` mediante parseo seguro de arreglos por variables de entorno y
  permisos `contents: write` acotados a nivel de job.

---

## [1.0.0] - 2026-11-01

**Nombre del Release:** "Initial AST-Driven Predictive CI & LPT Engine"\
**Tipo de Release:** Major Initial Release

### ✨ Added

- **Núcleo Deno 2 & TypeScript (Zero External Dependencies):** Arquitectura
  modular de ejecución en `<30ms` sin paquetes de terceros, eliminando riesgos de
  cadena de suministro.
- **Pipeline de 5 Etapas:**
  - **Etapa 1 — Extractor Quirúrgico de Diff Hunks (`src/git/diff-parser.ts`):**
    Análisis de `git diff --unified=0` a nivel de líneas y filtrado de ruido
    semántico (comentarios, docstrings y formato).
  - **Etapa 2 — Analizador AST Políglota (`src/ast/analyzer.ts`):** Detección de
    símbolos (`function`, `class`, `const`, `interface`, `type`, `enum`) y
    resolución de imports en TypeScript, JavaScript, Deno, Python, Rust y Go.
  - **Etapa 3 — Grafo Acíclico Dirigido Invertido (`src/graph/dag.ts`):** Cálculo
    de cierre transitivo mediante búsqueda en anchura (BFS) y disparadores
    globales de seguridad (`fail-safe-globs`).
  - **Etapa 4 — Balanceador Matemático LPT & Cuarentena Flaky
    (`src/scheduler/lpt-splitter.ts`):** Algoritmo _Greedy Longest Processing
    Time_ para generación de matrices dinámicas `strategy.matrix` en GitHub
    Actions y aislamiento automático de tests inestables.
  - **Etapa 5 — Reportería FinOps, Green-CI & Mermaid
    (`src/reporters/finops-reporter.ts`):** Exportación a `$GITHUB_OUTPUT`,
    `$GITHUB_STEP_SUMMARY` con grafo Mermaid del radio de explosión, ahorro en
    USD y reducción de huella de carbono ($\text{CO}_2\text{e}$).
- **Licencia:** Adopción formal de la Licencia MIT.

---

## Enlaces & Recursos

- 📖 [README.md](README.md) - Documentación General y Referencia de Marketplace
- 🏛️ [CONTRIBUTORS.md](CONTRIBUTORS.md) - Gobernanza y Sostenibilidad Técnica
- 🛡️ [SECURITY.md](.github/SECURITY.md) - Política de Seguridad y Arquitectura
  AppSec Zero-Trust
- 📜 [LICENSE](LICENSE) - Términos de Licencia MIT
- 🏷️ [CITATION.cff](CITATION.cff) - Referencia Académica y Metadatos de Software
