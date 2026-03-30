const fs = require('fs-extra');
const path = require('path');

const outputDir = path.join(__dirname, '..', 'test-data');

function writeJson(filename, value) {
  fs.ensureDirSync(outputDir);
  fs.writeJsonSync(path.join(outputDir, filename), value, { spaces: 2 });
}

function buildFunctionalCases() {
  const baseTimestamp = '2026-03-25T09:00:00.000Z';
  return {
    dataset: 'functional-cases',
    version: 1,
    generatedAt: new Date().toISOString(),
    source: 'Adapted for the cross-chain trusted data transport experiment prototype',
    purpose: 'Normal business requests used for correctness validation and demonstration in the paper prototype',
    cases: [
      {
        caseId: 'FUNC-001',
        businessType: 'asset-lock',
        priority: 'high',
        description: 'Cross-chain asset lock request from alliance chain to EVM settlement chain',
        expectedMode: 'normal',
        payload: {
          op: 'asset_lock',
          assetId: 'ASSET-CB-20260325-0001',
          owner: 'orgA.user001',
          amount: '1250.5000',
          unit: 'TOKEN',
          dstChain: 'evm-31337',
          reason: 'cross_chain_collateral',
          requestTime: baseTimestamp
        }
      },
      {
        caseId: 'FUNC-002',
        businessType: 'asset-mint-confirm',
        priority: 'high',
        description: 'Mint confirmation after source-chain escrow verification',
        expectedMode: 'normal',
        payload: {
          op: 'mint_confirm',
          escrowId: 'ESCROW-20260325-1002',
          beneficiary: '0xAb5801a7D398351b8bE11C439e05C5B3259aec9B',
          amount: '980.00',
          assetType: 'wrapped_invoice',
          notaryOrg: 'alliance-notary-01',
          requestTime: '2026-03-25T09:05:00.000Z'
        }
      },
      {
        caseId: 'FUNC-003',
        businessType: 'trade-finance',
        priority: 'medium',
        description: 'Supply-chain finance receivable confirmation data',
        expectedMode: 'normal',
        payload: {
          op: 'receivable_attest',
          receivableId: 'AR-PO-889102',
          buyer: 'city-hospital-group',
          supplier: 'med-device-supplier',
          amount: '285000.00',
          currency: 'CNY',
          dueDate: '2026-04-30',
          invoiceHash: 'sha256:25d1b0f778c95b6d0453d6d84612e5cc31f7cead8f4ed71f4dbe91a1732311c1'
        }
      },
      {
        caseId: 'FUNC-004',
        businessType: 'logistics-sync',
        priority: 'medium',
        description: 'Cold-chain logistics status synchronization',
        expectedMode: 'normal',
        payload: {
          op: 'logistics_sync',
          waybillId: 'WB-CC-20260325-04',
          cargoType: 'vaccine',
          currentTemperature: '-18.6',
          temperatureUnit: 'C',
          location: 'N31.2304,E121.4737',
          status: 'arrived_hub',
          inspector: 'iot-gateway-07'
        }
      },
      {
        caseId: 'FUNC-005',
        businessType: 'identity-attestation',
        priority: 'high',
        description: 'Identity credential attestation forwarded to target chain contract',
        expectedMode: 'normal',
        payload: {
          op: 'identity_attest',
          credentialId: 'DID-CRED-77801',
          issuer: 'university-ca',
          subject: 'student-20201234',
          credentialType: 'master-degree',
          validUntil: '2030-07-01',
          digest: 'sha256:444332b78874af0bd7ce7d7f269c676ee1a706ce3779b64175d0dc4a44f30228'
        }
      },
      {
        caseId: 'FUNC-006',
        businessType: 'medical-consent',
        priority: 'medium',
        description: 'Medical data authorization synchronization for consortium hospitals',
        expectedMode: 'normal',
        payload: {
          op: 'medical_consent',
          consentId: 'CONSENT-MED-20260325-006',
          patientId: 'PATIENT-009932',
          scope: ['imaging', 'lab-report'],
          grantee: 'hospital-b-chain',
          durationDays: 30,
          auditHash: 'sha256:52844d30f9ad1497b3d6bb4df5f0bbf41252e183114873746ca4f892618f67e7'
        }
      },
      {
        caseId: 'FUNC-007',
        businessType: 'carbon-credit',
        priority: 'medium',
        description: 'Carbon credit retirement record submission',
        expectedMode: 'normal',
        payload: {
          op: 'carbon_retire',
          creditBatch: 'CCER-2025-SOLAR-0021',
          amount: '350.75',
          projectOwner: 'green-grid-energy',
          verifier: 'env-audit-lab',
          retireReason: 'supply_chain_offset',
          settlementDate: '2026-03-25'
        }
      },
      {
        caseId: 'FUNC-008',
        businessType: 'iot-alert',
        priority: 'low',
        description: 'Industrial IoT threshold alert for target-chain automation',
        expectedMode: 'normal',
        payload: {
          op: 'iot_alert',
          deviceId: 'SENSOR-PLANT-88',
          metric: 'pressure',
          reading: '12.31',
          threshold: '10.00',
          level: 'warning',
          observedAt: '2026-03-25T09:20:00.000Z'
        }
      },
      {
        caseId: 'FUNC-009',
        businessType: 'government-subsidy',
        priority: 'medium',
        description: 'Subsidy eligibility confirmation for agricultural insurance',
        expectedMode: 'normal',
        payload: {
          op: 'subsidy_confirm',
          applicationId: 'SUB-AGRI-20260325-009',
          applicant: 'cooperative-jiangsu-01',
          region: 'Jiangsu',
          cropType: 'rice',
          insuredAreaMu: 1850,
          subsidyAmount: '46250.00'
        }
      },
      {
        caseId: 'FUNC-010',
        businessType: 'academic-certificate',
        priority: 'low',
        description: 'Academic certificate verification message',
        expectedMode: 'normal',
        payload: {
          op: 'certificate_verify',
          certificateNo: 'CERT-2026-000010',
          institution: 'alliance-university',
          major: 'blockchain engineering',
          graduateYear: 2026,
          status: 'valid',
          documentDigest: 'sha256:95a5af21e8842f0d4cefc883f27a7ca4d09ec5f53c6d5d51f0cf0d1ab8f8d8f2'
        }
      },
      {
        caseId: 'FUNC-011',
        businessType: 'oracle-update',
        priority: 'high',
        description: 'Trusted oracle update request with signed market data digest',
        expectedMode: 'normal',
        payload: {
          op: 'oracle_update',
          feed: 'CNY_USD_REFERENCE',
          roundId: 18221,
          price: '0.1387',
          sourceAgency: 'state-fx-lab',
          signedDigest: 'sha256:b70a6fa70844ccf9d8f67aa1f2d7b53fed6ed1a5728f16c6f65d159aa0d76f7c',
          publishTime: '2026-03-25T09:30:00.000Z'
        }
      },
      {
        caseId: 'FUNC-012',
        businessType: 'multi-party-approval',
        priority: 'high',
        description: 'Multi-party approval result used to trigger target-chain execution',
        expectedMode: 'normal',
        payload: {
          op: 'approval_commit',
          workflowId: 'WF-CROSS-APR-9012',
          approvers: ['bank-a', 'bank-b', 'notary-c'],
          threshold: 2,
          passed: true,
          summaryHash: 'sha256:8fbe8df3b6074975d59f17ef21e5272a191f74b93cb93f9f824cf7f2a6bca4fa',
          finishedAt: '2026-03-25T09:35:00.000Z'
        }
      }
    ]
  };
}

function buildSecurityCases() {
  return {
    dataset: 'security-cases',
    version: 1,
    generatedAt: new Date().toISOString(),
    source: 'Adapted from the trusted cross-chain transmission experiment design',
    purpose: 'Attack and abnormal-state cases used for security validation',
    cases: [
      {
        caseId: 'SEC-001',
        mode: 'tamper',
        referenceCaseId: 'FUNC-001',
        attackType: 'payload_tamper',
        description: 'Modify payload while keeping the original payloadHash unchanged',
        expectedFailurePoint: 'VerifierContract',
        expectedReason: 'payload hash mismatch'
      },
      {
        caseId: 'SEC-002',
        mode: 'tamper',
        referenceCaseId: 'FUNC-006',
        attackType: 'medical_scope_tamper',
        description: 'Expand authorized medical data scope after source-chain attestation',
        expectedFailurePoint: 'VerifierContract',
        expectedReason: 'payload hash mismatch'
      },
      {
        caseId: 'SEC-003',
        mode: 'replay',
        referenceCaseId: 'FUNC-002',
        attackType: 'request_replay',
        description: 'Submit an already accepted requestID for a second time',
        expectedFailurePoint: 'VerifierContract',
        expectedReason: 'replay requestID'
      },
      {
        caseId: 'SEC-004',
        mode: 'replay',
        referenceCaseId: 'FUNC-011',
        attackType: 'oracle_replay',
        description: 'Replay an old oracle update to test idempotent consumption',
        expectedFailurePoint: 'VerifierContract',
        expectedReason: 'replay requestID'
      },
      {
        caseId: 'SEC-005',
        mode: 'forged',
        referenceCaseId: 'FUNC-003',
        attackType: 'forged_event_proof',
        description: 'Replace eventProof with forged data while reusing the original request context',
        expectedFailurePoint: 'VerifierContract or TEE',
        expectedReason: 'invalid tee signature'
      },
      {
        caseId: 'SEC-006',
        mode: 'forged',
        referenceCaseId: 'FUNC-010',
        attackType: 'certificate_proof_forgery',
        description: 'Forge certificate verification proof to simulate malicious relayer tampering',
        expectedFailurePoint: 'VerifierContract or TEE',
        expectedReason: 'invalid tee signature'
      },
      {
        caseId: 'SEC-007',
        mode: 'rollback',
        referenceCaseId: 'FUNC-004',
        attackType: 'tee_state_rollback',
        description: 'Rollback TEE counter and previous digest to break state continuity',
        expectedFailurePoint: 'VerifierContract',
        expectedReason: 'non-monotonic ctr or continuity broken'
      },
      {
        caseId: 'SEC-008',
        mode: 'rollback',
        referenceCaseId: 'FUNC-012',
        attackType: 'digest_chain_break',
        description: 'Replay old TEE state for a later approval record',
        expectedFailurePoint: 'VerifierContract',
        expectedReason: 'non-monotonic ctr or continuity broken'
      }
    ]
  };
}

function buildPadding(targetBytes, seed) {
  const chunk = `${seed}|trusted-cross-chain|`;
  let out = '';
  while (Buffer.byteLength(out, 'utf8') < targetBytes) {
    out += chunk;
  }
  return out.slice(0, targetBytes);
}

function buildPerformanceCases() {
  const specs = [
    { caseId: 'PERF-001', label: 'tiny-256', targetBytes: 256, series: 'A' },
    { caseId: 'PERF-002', label: 'tiny-256', targetBytes: 256, series: 'B' },
    { caseId: 'PERF-003', label: 'small-1024', targetBytes: 1024, series: 'A' },
    { caseId: 'PERF-004', label: 'small-1024', targetBytes: 1024, series: 'B' },
    { caseId: 'PERF-005', label: 'medium-4096', targetBytes: 4096, series: 'A' },
    { caseId: 'PERF-006', label: 'medium-4096', targetBytes: 4096, series: 'B' },
    { caseId: 'PERF-007', label: 'large-8192', targetBytes: 8192, series: 'A' },
    { caseId: 'PERF-008', label: 'large-8192', targetBytes: 8192, series: 'B' },
    { caseId: 'PERF-009', label: 'xlarge-16384', targetBytes: 16384, series: 'A' },
    { caseId: 'PERF-010', label: 'xlarge-16384', targetBytes: 16384, series: 'B' },
    { caseId: 'PERF-011', label: 'xxlarge-32768', targetBytes: 32768, series: 'A' },
    { caseId: 'PERF-012', label: 'xxlarge-32768', targetBytes: 32768, series: 'B' }
  ];

  return {
    dataset: 'performance-cases',
    version: 1,
    generatedAt: new Date().toISOString(),
    source: 'Designed for latency, gas and throughput observations with different payload sizes',
    purpose: 'Payload size scaling data aligned with the performance evaluation part of the paper',
    cases: specs.map((spec, index) => {
      const payload = {
        op: 'benchmark_store',
        benchmarkGroup: spec.label,
        series: spec.series,
        sequence: index + 1,
        dataOwner: 'cross-chain-lab',
        dataTag: `payload-${spec.caseId.toLowerCase()}`,
        note: 'Used to compare end-to-end latency, TEE verification time and gas consumption',
        padding: buildPadding(spec.targetBytes, spec.caseId)
      };
      return {
        caseId: spec.caseId,
        label: spec.label,
        targetPayloadBytes: spec.targetBytes,
        expectedMode: 'normal',
        description: `Benchmark payload with approximately ${spec.targetBytes} bytes of business data`,
        payloadBytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
        payload
      };
    })
  };
}

function buildFabricRealCases() {
  return {
    dataset: 'fabric-real-cases',
    version: 1,
    generatedAt: new Date().toISOString(),
    source: 'Designed for real Fabric-mode end-to-end validation with the xcall chaincode',
    purpose: 'Real Fabric event emission cases used to verify listener, proof-builder, TEE verification and target-chain execution',
    cases: [
      {
        caseId: 'FABRIC-001',
        businessType: 'asset-lock',
        priority: 'high',
        description: 'Alliance-chain asset lock event emitted by Fabric chaincode and relayed to the target chain',
        expectedMode: 'fabric-real',
        expectedTargetFields: {
          op: 'asset_lock',
          recordId: 'FABRIC-ASSET-0001',
          actor: 'org1.userA',
          amount: '128.50'
        },
        payload: {
          op: 'asset_lock',
          assetId: 'FABRIC-ASSET-0001',
          owner: 'org1.userA',
          amount: '128.50',
          reason: 'collateral_lock',
          dstChain: 'evm-31337'
        }
      },
      {
        caseId: 'FABRIC-002',
        businessType: 'mint-confirm',
        priority: 'high',
        description: 'Fabric chaincode emits a mint confirmation after escrow review',
        expectedMode: 'fabric-real',
        expectedTargetFields: {
          op: 'mint_confirm',
          recordId: 'FABRIC-ESCROW-0002',
          actor: '0xAb5801a7D398351b8bE11C439e05C5B3259aec9B',
          amount: '980.00'
        },
        payload: {
          op: 'mint_confirm',
          escrowId: 'FABRIC-ESCROW-0002',
          beneficiary: '0xAb5801a7D398351b8bE11C439e05C5B3259aec9B',
          amount: '980.00',
          notaryOrg: 'org1-notary',
          assetType: 'wrapped_invoice'
        }
      },
      {
        caseId: 'FABRIC-003',
        businessType: 'trade-finance',
        priority: 'medium',
        description: 'Receivable attestation emitted by Fabric chaincode for supply-chain financing',
        expectedMode: 'fabric-real',
        expectedTargetFields: {
          op: 'receivable_attest',
          recordId: 'FABRIC-AR-889102',
          actor: 'med-device-supplier',
          amount: '285000.00'
        },
        payload: {
          op: 'receivable_attest',
          receivableId: 'FABRIC-AR-889102',
          buyer: 'city-hospital-group',
          supplier: 'med-device-supplier',
          amount: '285000.00',
          currency: 'CNY'
        }
      },
      {
        caseId: 'FABRIC-004',
        businessType: 'logistics-sync',
        priority: 'medium',
        description: 'Cold-chain logistics state update emitted on the real Fabric channel',
        expectedMode: 'fabric-real',
        expectedTargetFields: {
          op: 'logistics_sync',
          recordId: 'FABRIC-WB-20260326-04',
          actor: 'iot-gateway-07',
          amount: '-18.6'
        },
        payload: {
          op: 'logistics_sync',
          waybillId: 'FABRIC-WB-20260326-04',
          cargoType: 'vaccine',
          reading: '-18.6',
          status: 'arrived_hub',
          inspector: 'iot-gateway-07'
        }
      },
      {
        caseId: 'FABRIC-005',
        businessType: 'medical-consent',
        priority: 'medium',
        description: 'Medical consent grant emitted from Fabric and consumed by the target chain',
        expectedMode: 'fabric-real',
        expectedTargetFields: {
          op: 'medical_consent',
          recordId: 'FABRIC-CONSENT-0005',
          actor: 'hospital-b-chain',
          amount: '30'
        },
        payload: {
          op: 'medical_consent',
          consentId: 'FABRIC-CONSENT-0005',
          patientId: 'PATIENT-009932',
          grantee: 'hospital-b-chain',
          durationDays: 30,
          scope: ['imaging', 'lab-report']
        }
      },
      {
        caseId: 'FABRIC-006',
        businessType: 'oracle-update',
        priority: 'high',
        description: 'Market data update emitted by Fabric chaincode for oracle synchronization',
        expectedMode: 'fabric-real',
        expectedTargetFields: {
          op: 'oracle_update',
          recordId: 'CNY_USD_REFERENCE',
          actor: 'state-fx-lab',
          amount: '0.1387'
        },
        payload: {
          op: 'oracle_update',
          feed: 'CNY_USD_REFERENCE',
          price: '0.1387',
          sourceAgency: 'state-fx-lab',
          roundId: 18221,
          publishTime: '2026-03-26T15:00:00.000Z'
        }
      },
      {
        caseId: 'FABRIC-007',
        businessType: 'multi-party-approval',
        priority: 'high',
        description: 'Approval workflow commit emitted by Fabric to trigger target-chain execution',
        expectedMode: 'fabric-real',
        expectedTargetFields: {
          op: 'approval_commit',
          recordId: 'WF-FABRIC-APR-7007',
          actor: 'bank-a,bank-b,notary-c',
          amount: '2'
        },
        payload: {
          op: 'approval_commit',
          workflowId: 'WF-FABRIC-APR-7007',
          approvers: ['bank-a', 'bank-b', 'notary-c'],
          threshold: 2,
          passed: true
        }
      },
      {
        caseId: 'FABRIC-008',
        businessType: 'government-subsidy',
        priority: 'medium',
        description: 'Subsidy confirmation emitted by Fabric chaincode for target-chain settlement',
        expectedMode: 'fabric-real',
        expectedTargetFields: {
          op: 'subsidy_confirm',
          recordId: 'FABRIC-SUB-AGRI-0008',
          actor: 'cooperative-jiangsu-01',
          amount: '46250.00'
        },
        payload: {
          op: 'subsidy_confirm',
          applicationId: 'FABRIC-SUB-AGRI-0008',
          applicant: 'cooperative-jiangsu-01',
          region: 'Jiangsu',
          cropType: 'rice',
          subsidyAmount: '46250.00'
        }
      }
    ]
  };
}

function main() {
  writeJson('functional-cases.json', buildFunctionalCases());
  writeJson('security-cases.json', buildSecurityCases());
  writeJson('performance-cases.json', buildPerformanceCases());
  writeJson('fabric-real-cases.json', buildFabricRealCases());
  console.log(`Test datasets generated in ${outputDir}`);
}

main();
