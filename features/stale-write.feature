Feature: A stale write to an issue is refused, not merged

  Two agents read the same issue and both decide to rewrite it. The store
  takes the first write and refuses the second, because it was decided
  against a version that no longer exists. The refused agent reads the
  issue again and decides anew; nothing is merged behind its back.

  Scenario: two actors rewrite the same body, and the second one at the old version is refused
    Given a local issue store outside the working repository
    And an issue the agent created
    When another actor rewrites the issue's body at the version the agent read
    And the agent rewrites the body at the same old version
    Then the agent's update is refused as a conflict that names the body field
    And the issue keeps the other actor's body
