// ============================================================
// Canoil Canada - Price Increase Gmail Drafts
// Creates one draft per company with the PDF letter attached.
// HOW TO USE:
//   1. Open script.google.com
//   2. Paste this entire file into the editor
//   3. Go to Editor -> Services -> Add "Gmail API" (v1) and click Add
//   4. Click Run -> createAllDrafts
//   5. Approve permissions when prompted
//   6. Check Gmail Drafts folder
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

function createAllDrafts() {
  var companies = [
  {
    "company": "3M",
    "to": "rganderson2@mmm.com, rwhite3@mmm.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear 3M Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "3M_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Actuation Plus",
    "to": "info@actuationplus.com, graceo@actuationplus.com, patricia.locke@actuationplus.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Actuation Plus Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Actuation_Plus_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Actuator Specialties",
    "to": "sales@actuatorspecialties.com, jeff@actuatorspecialties.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Actuator Specialties Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Actuator_Specialties_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "AGEUS Chz",
    "to": "ageus@ageus.cz",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear AGEUS Chz Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "AGEUS_Chz_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Alleychem",
    "to": "trade@allychem.com.tw",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Alleychem Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Alleychem_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Andritz",
    "to": "austin.matthews@andritz.com, denise.reed@andritz.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Andritz Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Andritz_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Applied Industrial Technology",
    "to": "wpierce2@applied.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Applied Industrial Technology Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Applied_Industrial_Technology_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Atkins Realis/SNC Lavalin",
    "to": "andreja.cukina@atkinsrealis.ca",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Atkins Realis/SNC Lavalin Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Atkins_RealisSNC_Lavalin_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Atura Power (Brighton Beach)",
    "to": "Jay.Hrynyk@aturapower.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Atura Power (Brighton Beach) Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Atura_Power_(Brighton_Beach)_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Auma - Germany",
    "to": "rainer.frank@auma.com, manfred.kiefer@auma.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Auma - Germany Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Auma_-_Germany_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Austin Energy",
    "to": "clint.sinclair@austinenergy.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Austin Energy Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Austin_Energy_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "AXEL",
    "to": "celine.gasquet@axelch.com, fr.purchase@axelch.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear AXEL Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "AXEL_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Bay Valve Service",
    "to": "Bill.Williamson@iss-na.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Bay Valve Service Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Bay_Valve_Service_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Bureau of Indian Affairs",
    "to": "harlan.herder@bia.gov, stefan.olson@bia.gov",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Bureau of Indian Affairs Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Bureau_of_Indian_Affairs_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Bureau of Reclamation",
    "to": "pmier@usbr.gov",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Bureau of Reclamation Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Bureau_of_Reclamation_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Campbell Company",
    "to": "bdavies@mecampbell.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Campbell Company Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Campbell_Company_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Canadian Bearings",
    "to": "Alex.Wessner@canadianbearings.com, shawn.richard@canadianbearings.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Canadian Bearings Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Canadian_Bearings_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Canadian Nuclear Lab",
    "to": "louise.newton@cnl.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Canadian Nuclear Lab Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Canadian_Nuclear_Lab_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "CG Industrial Specialties",
    "to": "haileym@cgis.ca",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear CG Industrial Specialties Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "CG_Industrial_Specialties_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Chalmers & Kubeck",
    "to": "jdempsey@candksouth.com, egoldenberg@candk.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Chalmers & Kubeck Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Chalmers_&_Kubeck_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Cole Chemical",
    "to": "coleap@colechem.com, donna@colechem.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Cole Chemical Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Cole_Chemical_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Consumers Energy",
    "to": "supplychain@cmsenergy.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Consumers Energy Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Consumers_Energy_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Duke Energy",
    "to": "Debie.Ferguson@duke-energy.com, jeremy.hughes@duke-energy.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Duke Energy Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Duke_Energy_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "DYNO Tech",
    "to": "averdant@vpcchem.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear DYNO Tech Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "DYNO_Tech_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Eastern Oil",
    "to": "tmiell@eaternoil.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Eastern Oil Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Eastern_Oil_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Enbridge Pipeline",
    "to": "joshua.dawson@enbridge.com, joseph.wilk@enbridge.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Enbridge Pipeline Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Enbridge_Pipeline_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Energotech",
    "to": "nicoleta.stanciu@energotech.ro",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Energotech Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Energotech_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "EPT Clean Oil",
    "to": "bwinczura@cleanoil.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear EPT Clean Oil Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "EPT_Clean_Oil_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Fastenal",
    "to": "chrilee@fastenal.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Fastenal Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Fastenal_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Ferguson Industrial",
    "to": "scott.long1@ferguson.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Ferguson Industrial Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Ferguson_Industrial_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "FESTO - Canada",
    "to": "nagadev.nagesh@festo.com, frederick.pinto@festo.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear FESTO - Canada Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "FESTO_-_Canada_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "FloTech Inc (Florida)",
    "to": "JAllen@flotechinc.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear FloTech Inc (Florida) Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "FloTech_Inc_(Florida)_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Flowserve",
    "to": "KAnderson@flowserve.com, gdover@flowserve.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Flowserve Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Flowserve_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Framatome",
    "to": "adriano.mirkovic@framatome.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Framatome Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Framatome_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "GasoChem International",
    "to": "charu@gasochem.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear GasoChem International Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "GasoChem_International_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "GE Industrial Solutions",
    "to": "markmamaghani@geindustrialcompanies.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear GE Industrial Solutions Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "GE_Industrial_Solutions_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Georgia Western",
    "to": "Melissa@georgiawestern.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Georgia Western Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Georgia_Western_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Hermston Gen Co.",
    "to": "jeffrey.foley@perennialpower.net, tim.key@perennialpower.net",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Hermston Gen Co. Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Hermston_Gen_Co._-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Hydro Quebec",
    "to": "lambert.jeanne@hydroquebec.com, Langlois-Deshaies.Albert@hydroquebec.com, lefebvre.martine@hydroquebec.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Hydro Quebec Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Hydro_Quebec_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Ideal Supply",
    "to": "vwilken@idealsupply.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Ideal Supply Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Ideal_Supply_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "J. Oskam Steel",
    "to": "zali@oskam.com, wryan@cpeg.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear J. Oskam Steel Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "J._Oskam_Steel_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Kinectrics",
    "to": "Darren.CHAPMAN@kinectrics.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Kinectrics Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Kinectrics_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Lakeside Process Controls",
    "to": "kevin.bartle@lakesidecontrols.com, shelley.maki@lakesidecontrols.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Lakeside Process Controls Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Lakeside_Process_Controls_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "MDM Connections",
    "to": "mmoblicci@mdmconnections.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear MDM Connections Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "MDM_Connections_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Midstream Valve",
    "to": "paigel@midstreamvalve.com, aprild@midstreamvalve.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Midstream Valve Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Midstream_Valve_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Mil-COMM Products",
    "to": "wendy.servilio@mil-comm.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Mil-COMM Products Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Mil-COMM_Products_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Millspaw Electronics",
    "to": "gray@millspawelectronics.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Millspaw Electronics Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Millspaw_Electronics_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Mississippi Power",
    "to": "lwladner@southernco.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Mississippi Power Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Mississippi_Power_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "NAES",
    "to": "terri.wilson@naes.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear NAES Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "NAES_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "NB Power",
    "to": "dbent@nbpower.com, thall@nbpower.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear NB Power Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "NB_Power_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Nebraska Power (NPPD)",
    "to": "kshilge@nppd.com, jsbombe@nppd.com, tamerri@nppd.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Nebraska Power (NPPD) Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Nebraska_Power_(NPPD)_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "NJMJ Trinidad Tobago",
    "to": "neil@njmjco.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear NJMJ Trinidad Tobago Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "NJMJ_Trinidad_Tobago_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Northbank Civil & Marine",
    "to": "codyk@northbankcm.com, carolm@northbankcm.com, mshaw@northbankcm.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Northbank Civil & Marine Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Northbank_Civil_&_Marine_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "NYNE Mechanical",
    "to": "",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear NYNE Mechanical Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "NYNE_Mechanical_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "OPG",
    "to": "kurt.rabishaw@opg.com, muriel.haaksman@opg.com, linda.ryan@opg.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear OPG Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "OPG_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "OPG - Fabe",
    "to": "fabian.perissinotti@opg.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear OPG - Fabe Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "OPG_-_Fabe_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Paragon",
    "to": "jbriscoe@paragones.com, ttrombley@paragones.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Paragon Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Paragon_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Pengxin (Wuhan)",
    "to": "business@whpxjd.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Pengxin (Wuhan) Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Pengxin_(Wuhan)_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Rauh Chemical - Korea",
    "to": "rauhchem@naver.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Rauh Chemical - Korea Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Rauh_Chemical_-_Korea_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Refteck Solutions",
    "to": "stanleya@refteck.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Refteck Solutions Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Refteck_Solutions_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Rexel",
    "to": "",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Rexel Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Rexel_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "RG Group",
    "to": "julie.ingram@rg-group.com, liza.espiritu@rg-group.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear RG Group Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "RG_Group_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Rideout",
    "to": "jrideout@rideouttool.com, kokeefe@rideouttool.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Rideout Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Rideout_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Rotork UK",
    "to": "Ian.Kemmery@rotork.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Rotork UK Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Rotork_UK_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "SaskPower",
    "to": "amoore@saskpower.com, procurement@saskpower.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear SaskPower Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "SaskPower_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Sempell, GmbH",
    "to": "Nadine.Kirsch@Emerson.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Sempell, GmbH Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Sempell,_GmbH_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Severe Service Specialists",
    "to": "DavidS@sssvalve.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Severe Service Specialists Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Severe_Service_Specialists_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Sonsu Controls Inc.",
    "to": "pherwani@sonsucontrols.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Sonsu Controls Inc. Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Sonsu_Controls_Inc._-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Stock'd Supply",
    "to": "rcain@stockdsupply.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Stock'd Supply Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Stock'd_Supply_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "The Slover Group",
    "to": "richard_slover@slovergroup.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear The Slover Group Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "The_Slover_Group_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Tolko",
    "to": "philip.klein@tolko.com, michelle.warner@tolko.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Tolko Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Tolko_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "TransCanada",
    "to": "deryk_ross@tcenergy.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear TransCanada Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "TransCanada_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Turbo Supplies",
    "to": "purchasing7@turboss.net, support@turboss.net",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Turbo Supplies Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Turbo_Supplies_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "TVA",
    "to": "lrdesouza@tva.gov, blhill@tva.gov, trraby@tva.gov",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear TVA Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "TVA_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  },
  {
    "company": "Vallen",
    "to": "David.E.Anderson@vallen.com",
    "cc": "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com",
    "subject": "Canoil Canada Ltd. - Price Increase Effective April 15, 2026",
    "body": "Dear Vallen Team,\n\nPlease find attached our formal price increase notification for the products your company purchases from Canoil Canada.\n\nAs outlined in the attached letter, the updated prices will be effective April 15, 2026.\n\nShould you have any questions or require additional information, please do not hesitate to contact us.",
    "pdf_name": "Vallen_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026.pdf"
  }
];

  // Get the PDF Letters folder directly by ID
  var pdfFolder = null;
  try {
    pdfFolder = DriveApp.getFolderById('1mLgeuvKDMGSJQ3akrkO6_pxNdqvcvGmy');
    Logger.log('PDF Letters folder found: ' + pdfFolder.getName());
  } catch(e) {
    Logger.log('ERROR: Could not open PDF Letters folder: ' + e.message);
  }

  // Fetch Gmail signature once
  var signature = getGmailSignature();
  Logger.log(signature ? 'Signature loaded.' : 'No signature found - drafts will have no signature.');

  var created = 0;
  var skipped = 0;

  for (var i = 0; i < companies.length; i++) {
    var c = companies[i];

    if (c.to === '') {
      Logger.log('SKIPPED (no contacts): ' + c.company);
      skipped++;
      continue;
    }

    // Find the PDF in the folder
    var blob = null;
    if (pdfFolder) {
      var files = pdfFolder.getFilesByName(c.pdf_name);
      if (files.hasNext()) {
        blob = files.next().getBlob().setName(c.pdf_name);
      } else {
        Logger.log('WARNING: PDF not found: ' + c.pdf_name);
      }
    }

    // Build HTML body with signature appended
    var htmlBody = c.body.replace(/\n/g, '<br>');
    if (signature) {
      htmlBody += '<br><br>' + signature;
    }

    var options = { cc: c.cc, htmlBody: htmlBody };
    if (blob) { options.attachments = [blob]; }

    GmailApp.createDraft(c.to, c.subject, '', options);
    Logger.log('[' + (i + 1) + '/' + companies.length + '] Draft created: ' + c.company + (blob ? ' (+PDF)' : ' (no PDF)'));
    created++;
  }

  Logger.log('Done. ' + created + ' drafts created, ' + skipped + ' skipped (no contacts).');
}
