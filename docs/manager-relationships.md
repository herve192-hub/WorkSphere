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

MongoDB must run as a replica set or sharded cluster, as required by the API's
transactional audit history. Reporting assignments, status changes, and deletions
first update the same `employee_hierarchy_guards` document inside their MongoDB
transaction. Concurrent API processes then contend on that document; MongoDB
retries a conflicting transaction with fresh relationship reads. Snapshot reads
alone would allow reciprocal assignments that write different employee records.
The manager index supports direct-report lookups.

The guard update, relationship checks, employee write, and audit event commit or
roll back together. A failed validation or process crash cannot leave a held
application lock, and no expiring lease can permit overlapping writers. This
intentionally serializes hierarchy changes across the employee domain. Other
profile edits and employee creation without a manager do not acquire the guard.
Multiple processes must use the same employee database and guard collection.
Imports, scripts, and future write endpoints must use the employee service; direct
model or database writes bypass these relationship checks and coordination.

Existing invalid relationships are not rewritten on deployment. They can be
repaired explicitly by setting a valid manager or clearing `managerId`. Unrelated
profile edits remain available while legacy relationships are being repaired.
