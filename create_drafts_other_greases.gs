// ============================================================
// Canoil Canada - Other Greases - Gmail Drafts (PDF attached)
// 1. Services -> Add Gmail API v1
// 2. Run createAllDraftsOtherGreases
// ============================================================

function getGmailSignature() {
  try {
    var aliases = Gmail.Users.Settings.SendAs.list('me').sendAs;
    for (var i = 0; i < aliases.length; i++) {
      if (aliases[i].isDefault) {
        return aliases[i].signature || '';
      }
    }
  } catch(e) {
    Logger.log('Could not fetch signature: ' + e.message);
  }
  return '';
}

function createAllDraftsOtherGreases() {
  var companies = [
  {
    "company": "Applied Industrial Technology",
    "to": "rsawant@applied.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Applied Industrial Technology Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Applied_Industrial_Technology_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "BDI Canada",
    "to": "tom.beasley@bdi-canada.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear BDI Canada Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "BDI_Canada_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "CaesarStone",
    "to": "Tamara.Mojica@caesarstone.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear CaesarStone Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "CaesarStone_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "Canadian Bearings",
    "to": "Darian.Stewart@canadianbearings.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Canadian Bearings Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Canadian_Bearings_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "Cortez Industries",
    "to": "customerservice@sprayfoamparts.ca",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Cortez Industries Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Cortez_Industries_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "Day Distributing",
    "to": "daydistributing88@gmail.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Day Distributing Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Day_Distributing_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "DXP Enterprises",
    "to": "jennifer.largis@dxpe.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear DXP Enterprises Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "DXP_Enterprises_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "Engineered Custom Lubricants (ECL)",
    "to": "Sara.Wingate@quakerhoughton.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Engineered Custom Lubricants (ECL) Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Engineered_Custom_Lubricants_(ECL)_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "Fastenal",
    "to": "chrilee@fastenal.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Fastenal Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Fastenal_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "Flo Components",
    "to": "sales@flocomponents.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Flo Components Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Flo_Components_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "Franzenburg",
    "to": "corey.cunningham@frznbrg.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Franzenburg Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Franzenburg_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "GRP",
    "to": "fuk.grp-lub@japan-grp.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear GRP Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "GRP_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "GRTP SRI",
    "to": "renzo.guizzardi@grtp.it",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear GRTP SRI Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "GRTP_SRI_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "Harpoon Motorsports",
    "to": "",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Harpoon Motorsports Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Harpoon_Motorsports_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "LSI",
    "to": "admin@lubespec.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear LSI Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "LSI_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "Lubecore",
    "to": "hwang@lubecore.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Lubecore Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Lubecore_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "Lubri-Delta",
    "to": "s.ducharme@lubri-delta.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Lubri-Delta Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Lubri-Delta_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "Lubrification Quebec",
    "to": "agrenier@lubrificationquebec.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Lubrification Quebec Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Lubrification_Quebec_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "MINT'N DRY",
    "to": "pascal@mintndry.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear MINT'N DRY Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "MINT'N_DRY_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "Motion Industries",
    "to": "Brent.Luke@motion.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Motion Industries Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Motion_Industries_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "NH Oil Undercoating",
    "to": "joe@nhoilundercoating.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear NH Oil Undercoating Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "NH_Oil_Undercoating_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "PLZ Corp",
    "to": "joanne.houston@plzcorp.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear PLZ Corp Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "PLZ_Corp_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "PMGI",
    "to": "bill@pmgroupintl.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear PMGI Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "PMGI_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "Ventra Plastics",
    "to": "LJamieson@flexngate.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Ventra Plastics Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Ventra_Plastics_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "VIP Lubricants",
    "to": "vip.lubricants@gmail.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear VIP Lubricants Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "VIP_Lubricants_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "Wajax Industrial",
    "to": "sboisvert@wajax.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Wajax Industrial Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Wajax_Industrial_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  },
  {
    "company": "Walter Surface Technologies",
    "to": "ALongo@walter.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Walter Surface Technologies Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Walter_Surface_Technologies_-_Canoil_Canada_Other_Greases_Price_Increase_-_Apr_15_2026.pdf"
  }
];

  var pdfFolder = null;
  try {
    pdfFolder = DriveApp.getFolderById('1zfSGWO9RquRqyIXCmDOEG0Y2NAKxQ-Ws');
    Logger.log('Folder: ' + pdfFolder.getName());
  } catch(e) {
    Logger.log('ERROR opening PDF folder: ' + e.message);
  }

  var signature = getGmailSignature();
  Logger.log(signature ? 'Signature loaded.' : 'No signature.');

  var created = 0;
  var skipped = 0;

  for (var i = 0; i < companies.length; i++) {
    var c = companies[i];

    if (c.to === '') {
      Logger.log('SKIPPED (no email in list): ' + c.company);
      skipped++;
      continue;
    }

    var blob = null;
    if (pdfFolder) {
      var files = pdfFolder.getFilesByName(c.pdf_name);
      if (files.hasNext()) {
        blob = files.next().getBlob().setName(c.pdf_name);
      } else {
        Logger.log('WARNING: PDF not found: ' + c.pdf_name);
      }
    }

    var htmlBody = c.body.replace(/\n/g, '<br>');
    if (signature) {
      htmlBody += '<br><br>' + signature;
    }

    var options = { cc: c.cc, htmlBody: htmlBody };
    if (blob) { options.attachments = [blob]; }

    GmailApp.createDraft(c.to, c.subject, '', options);
    Logger.log('[' + (i + 1) + '/' + companies.length + '] ' + c.company + (blob ? ' (+PDF)' : ' (no PDF)'));
    created++;
  }

  Logger.log('Done. ' + created + ' drafts, ' + skipped + ' skipped.');
}
