const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// Update createNotification definition
code = code.replace(
  'function createNotification({ targetRole, targetEmpCode, targetGroup, type, title, message, link }) {',
  'function createNotification({ targetRole, targetEmpCode, targetGroup, type, title, message, link, targetId }) {'
);

code = code.replace(
  "link: link || '',\n      readBy",
  "link: link || '',\n      targetId: targetId || null,\n      readBy"
);

// 1. work-permits creation
code = code.replace(
  "link: 'tabPermits'\n          });\n          \n          if (p.employeeId) {\n            createNotification({\n              targetEmpCode: p.employeeId,\n              type: 'permit',\n              title: 'استلام طلب تصريح ✅',\n              message: 'تم استلام طلب تصريحك بنجاح وهو قيد المراجعة',\n              link: 'tabMyHistory'\n            });",
  "link: 'tabPermits',\n            targetId: p.id\n          });\n          \n          if (p.employeeId) {\n            createNotification({\n              targetEmpCode: p.employeeId,\n              type: 'permit',\n              title: 'استلام طلب تصريح ✅',\n              message: 'تم استلام طلب تصريحك بنجاح وهو قيد المراجعة',\n              link: 'tabMyHistory',\n              targetId: p.id\n            });"
);

// 2. PATCH /api/permits/:id
code = code.replace(
  "link: 'tabMyHistory'\n            });\n          } else if (action === 'reject' || action === 'area_reject') {\n            createNotification({\n              targetEmpCode: permits[idx].employeeId,\n              type: 'permit',\n              title: 'رفض التصريح ❌',\n              message: `تم رفض تصريحك رقم ${permits[idx].id} - السبب: ${reviewNote || 'غير محدد'}`,\n              link: 'tabMyHistory'\n            });\n          } else if (action === 'close') {\n            createNotification({\n              targetEmpCode: permits[idx].employeeId,\n              type: 'permit',\n              title: 'إغلاق التصريح 🔒',\n              message: `تم إنهاء وإغلاق التصريح رقم ${permits[idx].id}`,\n              link: 'tabMyHistory'\n            });\n          }",
  "link: 'tabMyHistory',\n              targetId: permits[idx].id\n            });\n          } else if (action === 'reject' || action === 'area_reject') {\n            createNotification({\n              targetEmpCode: permits[idx].employeeId,\n              type: 'permit',\n              title: 'رفض التصريح ❌',\n              message: `تم رفض تصريحك رقم ${permits[idx].id} - السبب: ${reviewNote || 'غير محدد'}`,\n              link: 'tabMyHistory',\n              targetId: permits[idx].id\n            });\n          } else if (action === 'close') {\n            createNotification({\n              targetEmpCode: permits[idx].employeeId,\n              type: 'permit',\n              title: 'إغلاق التصريح 🔒',\n              message: `تم إنهاء وإغلاق التصريح رقم ${permits[idx].id}`,\n              link: 'tabMyHistory',\n              targetId: permits[idx].id\n            });\n          }"
);

// 3. POST /api/hazards
code = code.replace(
  "link: 'tabSupHazard'\n      });\n      \n      if (newHazard.empCode) {\n        createNotification({\n          targetEmpCode: newHazard.empCode,\n          type: 'hazard',\n          title: 'استلام البلاغ 📥',\n          message: 'تم تسجيل بلاغك بنجاح وجارٍ مراجعته من قِبل السلامة',\n          link: 'tabHazardWorker'\n        });\n      }",
  "link: 'tabSupHazard',\n        targetId: newHazard.id\n      });\n      \n      if (newHazard.empCode) {\n        createNotification({\n          targetEmpCode: newHazard.empCode,\n          type: 'hazard',\n          title: 'استلام البلاغ 📥',\n          message: 'تم تسجيل بلاغك بنجاح وجارٍ مراجعته من قِبل السلامة',\n          link: 'tabHazardWorker',\n          targetId: newHazard.id\n        });\n      }"
);

// 4. PATCH /api/hazards/:id
code = code.replace(
  "link: 'tabMyHazards'\n        });",
  "link: 'tabMyHazards',\n          targetId: hazards[idx].id\n        });"
);

// 5. PATCH /api/permits/:id/worker-close
code = code.replace(
  "link: 'tabPermits'\n      });\n      \n      createNotification({\n        targetEmpCode: permits[idx].employeeId,\n        type: 'permit',\n        title: 'تأكيد إغلاق التصريح ✅',\n        message: 'تم إغلاق التصريح بسلامة',\n        link: 'tabMyHistory'\n      });",
  "link: 'tabPermits',\n        targetId: permits[idx].id\n      });\n      \n      createNotification({\n        targetEmpCode: permits[idx].employeeId,\n        type: 'permit',\n        title: 'تأكيد إغلاق التصريح ✅',\n        message: 'تم إغلاق التصريح بسلامة',\n        link: 'tabMyHistory',\n        targetId: permits[idx].id\n      });"
);

// 6. POST /api/trainings
code = code.replace(
  "link: 'tabTrainingWorker'\n      });",
  "link: 'tabTrainingWorker',\n        targetId: newTraining.id\n      });"
);

// 7. PUT /api/trainings/:id/close
code = code.replace(
  "link: 'tabTrainingAdmin'\n      });",
  "link: 'tabTrainingAdmin',\n        targetId: trainings[idx].id\n      });"
);

// 8. POST /api/trainings/:id/attend
code = code.replace(
  "link: 'tabTrainingAdmin'\n      });\n      \n      createNotification({\n        targetEmpCode: nCode,\n        type: 'training',\n        title: 'تأكيد الحضور ✅',\n        message: `تم تسجيل وتأكيد حضورك في محاضرة ${trn.title}`,\n        link: 'tabTrainingWorker'\n      });",
  "link: 'tabTrainingAdmin',\n        targetId: trn.id\n      });\n      \n      createNotification({\n        targetEmpCode: nCode,\n        type: 'training',\n        title: 'تأكيد الحضور ✅',\n        message: `تم تسجيل وتأكيد حضورك في محاضرة ${trn.title}`,\n        link: 'tabTrainingWorker',\n        targetId: trn.id\n      });"
);

// 9. background scheduler
code = code.replace(
  "link: 'tabTrainingWorker'\n          });\n          console.log",
  "link: 'tabTrainingWorker',\n            targetId: trn.id\n          });\n          console.log"
);

fs.writeFileSync('server.js', code);
console.log('done updating server.js');
