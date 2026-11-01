# 🛡️ Política de Seguridad y Arquitectura AppSec Zero-Trust (Security Policy)

En el proyecto **Vortex** (`glastor-core/vortex`), desarrollado por
`**GLASTOR-DEV** (división de desarrollo de GLASTOR®)`, la seguridad del
software, la inmunidad de la cadena de suministro y la protección de los
pipelines CI/CD son prioridades fundamentales.

---

## 📦 Versiones Soportadas

Mantenemos actualizaciones de seguridad activas para las versiones estables de
Vortex en la rama `main`:

| Versión | Estado de Soporte  | Tipo de Soporte                       |
| :------ | :----------------- | :------------------------------------ |
| `1.1.x` | :white_check_mark: | Soporte activo y parches de seguridad |
| `1.0.x` | :white_check_mark: | Parches de seguridad críticos         |
| `< 1.0` | :x: No soportada   | Fin de ciclo de vida (EOL)            |

---

## 🔒 Controles AppSec y DevSecOps Integrados (`src/security.ts`)

**Vortex** implementa una postura **Zero-Trust** alineada con OWASP Top 10,
CWE/SANS Top 25 y las guías de endurecimiento de GitHub Actions:

1. **Cero Dependencias Externas (Inmunidad Supply-Chain):** Ejecución 100%
   nativa sobre Deno 2 (`node:util`, `node:fs`, `node:path`,
   `node:assert/strict`) sin paquetes de terceros en npm o JSR.
2. **CWE-88 (_Git Argument Injection Prevention_):** `isValidGitRef` bloquea
   referencias `base-ref` / `head-ref` que inicien con `-` (ej. `--output=`,
   `--ext-diff`) y fuerza el delimitador `--` en `git diff`.
3. **CWE-22 (_Path Traversal Containment_):** `resolveSafeWorkspacePath` e
   `isSafeRelativeFilePath` garantizan contención léxica estricta dentro de
   `workspaceDir` para reportes, telemetría y archivos del diff.
4. **CWE-78 / CWE-93 (_Workflow Command & `$GITHUB_OUTPUT` Injection_):**
   `escapeWorkflowCommandData`, `escapeWorkflowCommandProperty` y
   `sanitizeGitHubOutputValue` escapan `%`, `\r`, `\n`, `:` y `,` según la
   especificación oficial del runner de GitHub.
5. **CWE-918 (_SSRF & Network DoS Protection_):** `isSafeGitHubApiUrl` exige
   transporte `https://` y un timeout estricto de `5000ms`
   (`AbortSignal.timeout`) al publicar comentarios en Pull Requests.

---

## 🚨 Reporte Responsable de Vulnerabilidades

Si descubres una vulnerabilidad de seguridad o un fallo que comprometa la
integridad de **Vortex** o los pipelines que orquesta, te solicitamos **no abrir
un issue público**. En su lugar, activa nuestro protocolo de divulgación
coordinada:

### Opción 1: GitHub Private Vulnerability Reporting (Recomendado)

Accede directamente a la herramienta oficial de GitHub: 👉
[Reportar vulnerabilidad privada en Vortex](https://github.com/glastor-core/vortex/security/advisories/new)

### Opción 2: Correo Electrónico Corporativo Seguro

Envía los detalles técnicos a nuestro canal oficial de seguridad: 📧
**[ventas@glastor.es](mailto:ventas@glastor.es)**

### Información a Incluir en el Reporte

Para acelerar el triaje y la mitigación, incluye:

- Descripción clara del fallo o vector de ataque (ej. inyección de argumentos en
  Git, evasión de podado AST, escalada de permisos en GitHub Actions).
- Pasos mínimos de reproducción o prueba de concepto (PoC).
- Impacto potencial en entornos de CI/CD.
- Código sugerido de mitigación o parche (si está disponible).

---

## ⏱️ SLA y Compromiso de Respuesta

- **Acuse de recibo:** Menos de 24 horas laborales.
- **Evaluación y confirmación:** Menos de 72 horas hábiles.
- **Publicación del parche y Advisory:** Divulgación coordinada una vez que la
  versión con la solución esté disponible en la rama `main` y en GitHub
  Marketplace.

Agradecemos profundamente el compromiso de la comunidad y los investigadores de
seguridad que colaboran en hacer de **Vortex** un estándar seguro para todos.

---

© 2010-2026 Andrés Antonio Cardoso — [GLASTOR®](https://glastor.es) — Todos los
derechos reservados
