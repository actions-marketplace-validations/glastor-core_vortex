# 🌌 Ingeniería y Estándares de Contribución

Gracias por sumarte a la misión de construir y evolucionar **Vortex**
(`glastor-core/vortex`) dentro del ecosistema de
`**GLASTOR-DEV** (división de desarrollo de GLASTOR®)`. Vortex es un motor de
inteligencia predictiva de CI/CD, podado de grafos de impacto AST a nivel de
símbolo y particionamiento matemático de tests (LPT) para GitHub Actions y CLI.

Valoramos la excelencia técnica, el rigor en seguridad Zero-Trust y el
compromiso con la calidad del software. Esta guía establece las directrices
operativas y de ingeniería para colaborar con máxima eficiencia (DX).

---

## 🛠 Gestión Estratégica de Incidencias

### 🐛 Reportes de Errores (Fidelidad Técnica)

Cada _issue_ debe actuar como un documento técnico verificable:

- **Executive Summary:** Resumen conciso del impacto y el alcance.
- **Protocolo de Reproducción:** Pasos exactos y deterministas para replicar el
  problema.
- **Análisis de Desviación:** Contraste claro entre el resultado observado y el
  esperado.
- **Entorno de Ejecución:**
  - Versión de Deno (`deno --version`)
  - Sistema Operativo (Linux, macOS, Windows)
  - Modo de ejecución: CLI local o GitHub Action (`action.yml`)
- **Evidencia Técnica:** Logs de consola, trazas de error o reporte
  `vortex-report.json`.

### 💡 Propuesta de Nuevos Analizadores AST o Algoritmos de Scheduling

Para proponer mejoras en el motor de análisis estático, resolución de grafos o
balanceo de carga:

1. **Definición del Escenario:** Qué lenguaje, patrón de importación, alias de
   monorepo o cuello de botella de CI/CD se aborda.
2. **Estrategia Técnica:** Análisis AST determinista (`<30ms`), sin expresiones
   regulares vulnerables a ReDoS y manteniendo **cero dependencias externas**.
3. **Impacto en Métricas FinOps:** Cómo mejora la precisión del podado de
   aristas (`prunedEdges`) o el _makespan_ de los shards paralelos.
4. **Cobertura de Tests:** Casos de prueba unitarios y end-to-end en `/tests/`.

---

## 💻 Setup del Entorno de Desarrollo

### Requisitos Previos

- **Deno:** 2.0+ instalado ([instrucciones de instalación](https://deno.com/)).
- **Git:** 2.30+.

### 1. Clonación del Repositorio y Activación de Git Hooks

```bash
git clone https://github.com/glastor-core/vortex.git
cd vortex

# Activar Git hooks locales nativos (pre-commit, commit-msg y pre-push en .githooks/)
deno task setup
```

### 2. Comandos y Tareas Disponibles

Vortex gestiona sus scripts de desarrollo directamente a través de `deno.json`:

```bash
# Verificación de tipos TypeScript estricta
deno task check

# Formateo de código según los estándares del proyecto
deno task fmt

# Análisis estático y linter
deno task lint

# Ejecutar suite completa de pruebas automatizadas (Unitarias + E2E + AppSec)
deno task test

# Ejecutar análisis de impacto AST sobre el propio repositorio (dogfooding)
deno task start

# Compilar binario nativo standalone
deno task compile
```

---

## 🚀 Flujo de Integración y Pull Requests

Para preservar la estabilidad de la rama principal (`main`), seguimos un flujo
riguroso:

### 1. Rama de Trabajo

Crea una rama descriptiva partiendo de `main` (incluyendo opcionalmente el ID
del ticket para trazabilidad automática):

```bash
git checkout -b feat/GLS-402-rust-workspace-resolver
# o: git checkout -b fix/lpt-shard-tiebreaker
```

### 2. Estándares de Código

- **TypeScript Estricto & Cero Dependencias Externas:** Tipado exhaustivo sin
  `any` y uso exclusivo de módulos nativos del runtime Deno 2.
- **Arquitectura Modular:**
  - `/src/git/`: Parser quirúrgico de `git diff --unified=0` y filtro de ruido
    semántico (`diff-parser.ts`).
  - `/src/ast/`: Analizador AST políglota, expansión de llamadas intra-módulo y
    resolución de alias de monorepos (`analyzer.ts`).
  - `/src/graph/`: Grafo acíclico dirigido invertido (Reverse DAG) y podado de
    _barrel files_ a nivel de símbolo (`dag.ts`).
  - `/src/scheduler/`: Algoritmo LPT Bin-Packing, ordenamiento _Fail-Fast_ y
    auto-aprendizaje EWMA (`lpt-splitter.ts`).
  - `/src/governance/`: Extractor de tickets Jira/Linear/GitHub, _Blast-Radius
    Gatekeeper_ y puente con `glastor-core/nemesis` (`gatekeeper.ts`).
  - `/src/reporters/`: Generador de `$GITHUB_OUTPUT`, `$GITHUB_STEP_SUMMARY` con
    Mermaid, anotaciones nativas y comentarios sticky en PRs
    (`finops-reporter.ts`).
  - `/src/security.ts`: Guardias AppSec Zero-Trust (CWE-88, CWE-22, CWE-78,
    CWE-93, CWE-918).
- **Verificación Local Obligatoria:** Asegúrate de que pasen sin errores:
  ```bash
  deno fmt --check && deno lint && deno task check && deno task test
  ```

### 3. Protocolo de Commits (Conventional Commits)

Implementamos la especificación de
[Conventional Commits](./COMMIT_CONVENTION.md):

```bash
git commit -m "feat(ast): add workspace alias resolution for deno.json"
git commit -m "sec(appsec): enforce CWE-88 git ref validation"
```

Prefijos permitidos: `feat:`, `fix:`, `perf:`, `sec:`, `docs:`, `style:`,
`refactor:`, `test:`, `ci:`, `chore:`.

### 4. Publicación y PR

Envía tu rama al repositorio remoto y abre un Pull Request hacia la rama `main`:

```bash
git push origin feat/GLS-402-rust-workspace-resolver
```

Completa el formulario generado por el
[PULL_REQUEST_TEMPLATE.md](./PULL_REQUEST_TEMPLATE.md) asegurando que todos los
puntos del checklist estén marcados.

---

## 📧 Canales de Comunicación y Soporte

- **GitHub Discussions:**
  [glastor-core/vortex/discussions](https://github.com/glastor-core/vortex/discussions)
  (consultas de arquitectura y propuestas).
- **GitHub Issues:**
  [glastor-core/vortex/issues](https://github.com/glastor-core/vortex/issues)
  (bugs y tareas).
- **Sitio Web Oficial:** [https://glastor.es](https://glastor.es)
- **Soporte Corporativo:** [ventas@glastor.es](mailto:ventas@glastor.es)
- **Comunicación Directa (Telegram):** [@zerhocool](https://t.me/zerhocool)

---

## Código de Conducta

Este proyecto se rige bajo nuestro [Código de Conducta](./CODE_OF_CONDUCT.md).
Fomentamos un entorno de respeto mutuo, inclusión y rigor profesional.

© 2010-2026 Andrés Antonio Cardoso — [GLASTOR®](https://glastor.es) — Todos los
derechos reservados
