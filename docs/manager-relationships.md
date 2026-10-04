# Manager relationships

Manager relationships are validated by the employee service on POST and PATCH.
The selected manager must exist and have an `ACTIVE` or `ON_LEAVE` employment
status. Legacy records without a status retain the model's default interpretation
of `ACTIVE`. An employee cannot manage themselves. Assignments cannot introduce
a reporting cycle or connect to an existing cyclic or broken reporting chain.

Creating an employee without `managerId` leaves it null. On PATCH, omitting
`managerId` preserves the existing manager. Explicitly setting it to null clears
the relationship. Other profile edits do not silently alter manager assignments.

## Deletion and deactivation policy

Deletion and changes to `INACTIVE` or `TERMINATED` are blocked while any direct
reports still reference the employee. This includes reports of every employment
status. Neither action automatically removes relationships or chooses a new
manager. HR managers and admins can explicitly handle each direct report first:

```http
PATCH /api/v1/employees/<direct-report-id>
Content-Type: application/json

{"managerId":"<replacement-manager-object-id>"}
```

Or explicitly clear the manager:

```json
{"managerId":null}
```

Once all direct reports are handled, HR or an admin can deactivate the manager,
and an admin can delete them. `ON_LEAVE` preserves existing relationships and
allows new assignments. A rejected operation leaves employee data unchanged.

## API errors

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | `managerId` is not a valid ObjectId string or null. |
| 400 | `MANAGER_NOT_FOUND` | The selected manager does not exist. |
| 400 | `SELF_MANAGEMENT` | The employee selected themselves as manager. |
| 400 | `MANAGER_UNAVAILABLE` | The selected manager is not active or on leave. |
| 400 | `REPORTING_CYCLE` | The assignment creates a cycle or the selected reporting chain already contains one. |
| 409 | `INVALID_MANAGER_HIERARCHY` | An ancestor has a missing or malformed manager reference. |
| 409 | `MANAGER_HAS_DIRECT_REPORTS` | Deletion or deactivation requires handling direct reports first. `error.details.directReportCount` gives the remaining count. |
| 404 | `EMPLOYEE_NOT_FOUND` | The employee being updated or deleted does not exist. |

## Deployment scope and existing data

The current application runs one API process with standalone MongoDB. Reporting
assignments, status changes, and deletions are serialized within that process so
concurrent API requests cannot pass stale checks and leave dangling references
or cycles. The manager index supports direct-report lookups.

Before running multiple API processes or workers, replace this process-local
coordination with a shared lock or MongoDB transactions that coordinate competing
hierarchy writes. Snapshot reads alone do not prevent reciprocal assignments.
Imports, scripts, and future write endpoints must use the employee service; direct
model or database writes bypass these relationship checks and coordination.

Existing invalid relationships are not rewritten on deployment. They can be
repaired explicitly by setting a valid manager or clearing `managerId`. Unrelated
profile edits remain available while legacy relationships are being repaired.
