# 🏛️ Arquitectura de Mensajes de Commit (Conventional Commits)

Para escalar el desarrollo de **Vortex** (`glastor-core/vortex`) y garantizar
una **Software Supply Chain** transparente, este repositorio implementa una
convención estricta basada en el
[estándar de Angular](https://github.com/conventional-changelog/conventional-changelog/tree/master/packages/conventional-changelog-angular).
Esta práctica no es solo estética: es el motor que impulsa nuestra
automatización de versiones SemVer, generación de changelogs, trazabilidad de
tickets y auditoría técnica.

## ⚙️ Especificación Técnica y Validación

Todo aporte debe superar el esquema de validación definido por la siguiente
expresión regular para integrarse en el flujo de CI/CD de la rama `main`:

```js
/^(revert: )?(feat|fix|polish|docs|style|refactor|perf|test|workflow|ci|chore|types|sec)(\([\w.-]+\))?: .{1,72}$/;
```

### Parámetros de Calidad (Linting):

- **Scope (Opcional):** Define el módulo de Vortex afectado entre paréntesis
  (ej. `ast`, `dag`, `scheduler`, `governance`, `reporters`, `appsec`).
- **Sujeto:** Conciso y descriptivo en modo imperativo.
- **DX-First:** Historiales limpios facilitan el análisis diferencial de
  `git diff --unified=0` y el _cherry-picking_.

---

## 🏗️ Estructura del Mensaje

Adoptamos un formato de tres bloques para maximizar la legibilidad y la
compatibilidad con herramientas de orquestación:

```text
<tipo>(<scope>): <asunto>

<body>

<footer>
```

### 1. Header (Obligatorio)

| Tipo              | Impacto en DX                                  | ¿Aparece en Changelog? |
| :---------------- | :--------------------------------------------- | :--------------------: |
| `feat`            | Implementación de nueva funcionalidad.         |         **Sí**         |
| `fix`             | Resolución de un bug o regresión.              |         **Sí**         |
| `perf`            | Optimización de latencia AST/DAG o recursos.   |         **Sí**         |
| `sec`             | Endurecimiento de seguridad AppSec / CWE.      |         **Sí**         |
| `refactor`        | Mejora de arquitectura o legibilidad.          |           No           |
| `docs`            | Actualización de documentación técnica.        |           No           |
| `test`            | Incremento de cobertura o fixes de testing.    |           No           |
| `ci` / `workflow` | Ajustes en pipelines y automatización.         |           No           |
| `chore`           | Mantenimiento de configuración y tooling.      |           No           |
| `style`           | Formateo de código (`deno fmt` / `deno lint`). |           No           |
| `types`           | Refinamiento de definiciones de tipos TS.      |           No           |
| `polish`          | Refinamientos menores de UX/UI en reportes.    |           No           |

> 💡 **Impacto en SemVer:** Cualquier commit con un `BREAKING CHANGE` en el
> footer forzará un incremento de versión mayor (_Major Release_),
> independientemente del tipo.

### 2. Body (Opcional)

Describe la motivación técnica del cambio. Contrasta la solución actual con el
comportamiento previo para facilitar la revisión de pares (Code Review).

### 3. Footer (Opcional)

Espacio crítico para metadatos y gobernanza de la tarea (detectado
automáticamente por el módulo `src/governance/gatekeeper.ts` de Vortex):

- **Referencias:** Vincula tickets de Jira, Linear o GitHub Issues mediante
  claves: `Closes #123`, `Resolves GLS-402`.
- **Breaking Changes:** Debe iniciar con `BREAKING CHANGE:` seguido de una
  explicación clara sobre la pérdida de compatibilidad hacia atrás.

---

## 🔄 Reversiones (Reverts)

En caso de rollback, el mensaje debe iniciar con `revert:`, seguido del header
original. Es imperativo incluir el hash del commit afectado en el cuerpo:
`This reverts commit <hash>`.

## ✍️ Firmas y Trazabilidad (DCO)

Se fomenta el uso de trailers estándar de Git como `Co-authored-by:` para dar
crédito a colaboraciones múltiples. La firma `Signed-off-by:` garantiza el
cumplimiento con el Developer Certificate of Origin si el flujo de trabajo lo
requiere.

© 2010-2026 Andrés Antonio Cardoso — [GLASTOR®](https://glastor.es) — Todos los
derechos reservados
